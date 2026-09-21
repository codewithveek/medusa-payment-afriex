import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  Logger,
  MedusaContainer,
  PaymentSessionDTO,
  PaymentSessionStatus,
} from "@medusajs/framework/types"
import type {
  TransactionWebhookData,
  TransactionWebhookPayload,
  WebhookPayload,
} from "@afriex/sdk"
import { amountsEqual, toAmountNumber } from "./amounts"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_PLUGIN_ROUTE_MARKER,
  AFRIEX_PROVIDER_ID_PREFIX,
} from "./constants"
import { claimEvent, releaseClaim } from "./idempotency-store"
import {
  isFinalRecordedStatus,
  isSettled,
  mapAfriexStatusToMedusaStatus,
} from "./map-status"
import type { AfriexExtraDeposit, AfriexSessionData } from "./types"
import { buildEventId, getSessionId, isTransactionEvent } from "./webhook-mapping"

export type WebhookResult = {
  success: boolean
  statusCode?: number
  error?: string
  /** What the handler did, surfaced for logs and tests. */
  outcome?:
    | "ignored"
    | "duplicate"
    | "unknown_session"
    | "captured"
    | "amount_mismatch"
    | "extra_deposit"
    | "status_recorded"
}

/** The slice of Medusa's Query the post-capture check needs. */
type GraphQuery = {
  graph(input: {
    entity: string
    fields: string[]
    filters: Record<string, unknown>
  }): Promise<{ data: Record<string, unknown>[] }>
}

/** How far back the account-id fallback looks for a session. Dedicated accounts expire well inside this. */
const FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const FALLBACK_SCAN_LIMIT = 500

/**
 * The single path by which Afriex can change payment state in Medusa.
 *
 * Order of operations matters here. The signature is checked before the
 * payload is allowed to drive anything — no database read, no lookup keyed on
 * a value the sender chose. Signature verification is delegated to the
 * payment provider, which is the only component holding the webhook public
 * key; every registered Afriex provider is tried, since nothing in an
 * unverified payload can be trusted to say which one it belongs to.
 */
export async function processAfriexWebhook(
  container: MedusaContainer,
  rawBody: Buffer | string,
  headers: Record<string, unknown>
): Promise<WebhookResult> {
  const logger = container.resolve<Logger>("logger")
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const rawString = rawBody.toString()

  // Parsed before verification only to decide whether the event is ours at all.
  // Nothing is read or written off the back of it until the signature checks out.
  let parsed: WebhookPayload
  try {
    parsed = JSON.parse(rawString) as WebhookPayload
  } catch {
    return { success: false, statusCode: 400, error: "Malformed payload" }
  }

  if (!isTransactionEvent(parsed)) {
    return { success: true, outcome: "ignored" }
  }

  const providerId = await verifySignature(paymentModule, parsed, rawString, headers)

  if (!providerId) {
    logger.warn(
      `Afriex webhook for transaction ${String(parsed.data?.transactionId)} failed signature verification.`
    )
    return { success: false, statusCode: 401, error: "Invalid signature" }
  }

  // From here the payload is Afriex's own. Its reference is still checked for
  // shape before it touches the database: the type says string, the wire does not.
  const transaction = parsed.data
  const rawReference: unknown = getSessionId(transaction)
  const reference =
    typeof rawReference === "string" && rawReference ? rawReference : undefined

  // Two independent threads lead back to a session: the reference, and the
  // account the money landed in. A missing or unusable reference only rules
  // out the first — the deposit may still be perfectly attributable.
  let session: PaymentSessionDTO | undefined
  try {
    session =
      (reference ? await retrieveSession(paymentModule, reference) : undefined) ??
      (await findSessionByAccount(paymentModule, providerId, transaction))
  } catch (error) {
    // Not a miss — the lookup itself failed. A 200 here would tell Afriex the
    // event was handled and end its retries.
    logger.error(
      `Afriex webhook for transaction ${String(transaction.transactionId)} could not be looked up: ${(error as Error).message}`
    )
    return { success: false, statusCode: 500, error: "Session lookup failed" }
  }

  if (!session) {
    logUnmatched(
      logger,
      transaction,
      reference
        ? `referenced unknown payment session ${reference}`
        : "carried no usable reference and named no known account"
    )
    return { success: true, outcome: "unknown_session" }
  }

  if (session.provider_id !== providerId) {
    // Verified by one registration's key, addressed to a session that belongs
    // to another. Nothing legitimate produces that.
    logger.warn(
      `Afriex webhook for session ${session.id} was signed for provider ${providerId} but the session belongs to ${session.provider_id}.`
    )
    return { success: false, statusCode: 401, error: "Invalid signature" }
  }

  const eventId = buildEventId(parsed)

  if (!(await claimEvent(container, eventId))) {
    return { success: true, outcome: "duplicate" }
  }

  try {
    const outcome = await reconcile(container, session, parsed)
    return { success: true, outcome }
  } catch (error) {
    // An event that failed halfway must stay retryable, so the claim goes back.
    await releaseClaim(container, eventId)
    logger.error(
      `Afriex webhook reconciliation failed for session ${session.id}: ${
        (error as Error).message
      }`
    )
    return { success: false, statusCode: 500, error: "Reconciliation failed" }
  }
}

async function reconcile(
  container: MedusaContainer,
  session: PaymentSessionDTO,
  event: TransactionWebhookPayload
): Promise<NonNullable<WebhookResult["outcome"]>> {
  const logger = container.resolve<Logger>("logger")
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const data = (session.data ?? {}) as unknown as AfriexSessionData
  const transaction = event.data

  if (!isSettled(transaction.status)) {
    // Progress events arrive out of order and in parallel. Once money has
    // moved behind a status, a straggling PROCESSING must not undo it.
    if (isFinalRecordedStatus(data.currentStatus)) {
      logger.info(
        `Afriex ${transaction.status} for session ${session.id} arrived after ${data.currentStatus}; left as is.`
      )
      return "status_recorded"
    }

    await writeStatus(paymentModule, session, {
      ...data,
      currentStatus: transaction.status,
      afriexTransactionId: transaction.transactionId,
    })
    return "status_recorded"
  }

  // From here the deposit has settled.

  const isNewTransaction =
    !!data.afriexTransactionId &&
    data.afriexTransactionId !== transaction.transactionId
  const alreadyPaid =
    data.currentStatus === "SUCCESS" ||
    session.status === "authorized" ||
    session.status === "captured"

  if (alreadyPaid && isNewTransaction) {
    // A second transfer against a session that is already paid. Medusa would
    // treat a re-capture as a no-op and the money would vanish from every
    // record. It is written down instead, for someone to refund.
    await writeStatus(paymentModule, session, {
      ...data,
      extraDeposits: [...(data.extraDeposits ?? []), toExtraDeposit(transaction)],
    })

    logger.error(
      `Afriex deposit ${transaction.transactionId} of ${transaction.destinationAmount} ${transaction.destinationCurrency} landed on session ${session.id}, which was already paid by ${data.afriexTransactionId}. Needs a refund.`
    )

    return "extra_deposit"
  }

  // An earlier settled deposit this one supersedes (a mismatch the shopper
  // then corrected with a second transfer) is money too. Keep it.
  const carriedDeposits =
    isNewTransaction && data.receivedAmount
      ? [
          ...(data.extraDeposits ?? []),
          {
            transactionId: data.afriexTransactionId!,
            amount: data.receivedAmount,
            currency: data.receivedCurrency,
            receivedAt: new Date().toISOString(),
          },
        ]
      : data.extraDeposits

  const expectedAmount = toAmountNumber(session.amount)
  const receivedAmount = transaction.destinationAmount
  const expectedCurrency = session.currency_code.toUpperCase()
  const receivedCurrency = transaction.destinationCurrency?.toUpperCase()

  // Compared against the session's own amount rather than the copy the plugin
  // stored at initiation: the session is what the customer is being charged,
  // and it is the value Medusa will capture.
  if (
    !amountsEqual(receivedAmount, expectedAmount) ||
    receivedCurrency !== expectedCurrency
  ) {
    await writeStatus(
      paymentModule,
      session,
      {
        ...data,
        currentStatus: AFRIEX_AMOUNT_MISMATCH,
        receivedAmount,
        receivedCurrency,
        afriexTransactionId: transaction.transactionId,
        extraDeposits: carriedDeposits,
      },
      "requires_more"
    )

    logger.warn(
      `Afriex deposit for session ${session.id} did not match: expected ${expectedAmount} ${expectedCurrency}, received ${receivedAmount} ${receivedCurrency}. Left for manual review.`
    )

    return "amount_mismatch"
  }

  await writeStatus(paymentModule, session, {
    ...data,
    currentStatus: transaction.status,
    receivedAmount,
    receivedCurrency,
    afriexTransactionId: transaction.transactionId,
    extraDeposits: carriedDeposits,
  })

  // Authorizes the session, captures the payment, and completes the cart into
  // an order. Medusa owns that sequence; the plugin only reports the deposit.
  await processPaymentWorkflow(container).run({
    input: {
      action: PaymentActions.SUCCESSFUL,
      data: { session_id: session.id, amount: toAmountNumber(receivedAmount) },
    },
  })

  // The workflow tolerates a great deal on the way through — a deferred
  // authorization, a cart that would not complete — and reports none of it.
  // Money has arrived; the only acceptable end state is a payment on this
  // session and an order behind it. Anything less is thrown, which releases
  // the idempotency claim so Afriex's retry gets another attempt, and is
  // logged at error level each time so it cannot fail quietly.
  await assertCaptured(container, session)

  return "captured"
}

/**
 * Tries every registered Afriex provider until one verifies the payload.
 * Returns that provider's fully-qualified id, or undefined when none does.
 */
async function verifySignature(
  paymentModule: IPaymentModuleService,
  parsed: TransactionWebhookPayload,
  rawString: string,
  headers: Record<string, unknown>
): Promise<string | undefined> {
  const providers = await paymentModule.listPaymentProviders(
    {},
    { select: ["id"] }
  )

  for (const provider of providers) {
    if (!provider.id.startsWith(AFRIEX_PROVIDER_ID_PREFIX)) {
      continue
    }

    try {
      const verified = await paymentModule.getWebhookActionAndData({
        // Medusa prepends `pp_` before resolving the provider, so the already
        // fully-qualified id has to have it stripped or the lookup goes
        // looking for `pp_pp_afriex_afriex` and throws.
        provider: provider.id.replace(/^pp_/, ""),
        payload: {
          data: parsed as unknown as Record<string, unknown>,
          rawData: rawString,
          // Tells the provider this event came through the plugin's route.
          // Without it the provider assumes Medusa's generic endpoint and
          // refuses the event out loud.
          headers: { ...headers, [AFRIEX_PLUGIN_ROUTE_MARKER]: "1" },
        },
      })

      if (verified.action !== PaymentActions.NOT_SUPPORTED) {
        return provider.id
      }
    } catch {
      // A registration the module could not resolve is not the one this
      // event was signed for. Keep looking.
    }
  }

  return undefined
}

/**
 * Deposits into a dedicated virtual account name that account as their
 * destination, and the plugin recorded which session the account was minted
 * for. That is a second, independent thread back to the cart when the
 * reference did not survive the trip.
 */
async function findSessionByAccount(
  paymentModule: IPaymentModuleService,
  providerId: string,
  transaction: TransactionWebhookData
): Promise<PaymentSessionDTO | undefined> {
  // A deposit "pulls funds from a source payment method", so the virtual
  // account is normally the transaction's source. Both ends are checked: a
  // payment method id identifies exactly one dedicated account either way.
  const accountIds = [transaction.sourceId, transaction.destinationId].filter(
    (id): id is string => typeof id === "string" && id.length > 0
  )

  if (!accountIds.length) {
    return undefined
  }

  const since = new Date(Date.now() - FALLBACK_LOOKBACK_MS).toISOString()
  const candidates = await paymentModule.listPaymentSessions(
    { provider_id: providerId, created_at: { $gte: since } },
    { take: FALLBACK_SCAN_LIMIT, order: { created_at: "DESC" } }
  )

  return candidates.find((candidate) => {
    const data = candidate.data as unknown as Partial<AfriexSessionData> | undefined
    return (
      data?.collectionMethod === "dedicated" &&
      typeof data.afriexPaymentMethodId === "string" &&
      accountIds.includes(data.afriexPaymentMethodId)
    )
  })
}

async function assertCaptured(
  container: MedusaContainer,
  session: PaymentSessionDTO
): Promise<void> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const after = await paymentModule.retrievePaymentSession(session.id, {
    relations: ["payment"],
  })

  if (!after.payment) {
    throw new Error(
      `deposit settled but no payment was recorded on session ${session.id}`
    )
  }

  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)

  const { data: cartLinks } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["cart_id"],
    filters: { payment_collection_id: session.payment_collection_id },
  })
  const cartId = cartLinks[0]?.cart_id

  if (!cartId) {
    // A payment collection with no cart (an admin-created one, for instance)
    // has nothing further to complete.
    return
  }

  const { data: orderLinks } = await query.graph({
    entity: "order_cart",
    fields: ["order_id"],
    filters: { cart_id: cartId },
  })

  if (!orderLinks.length) {
    throw new Error(
      `deposit settled and captured on session ${session.id} but cart ${cartId} did not complete into an order`
    )
  }
}

/**
 * Records what Afriex reported onto the session.
 *
 * The session status is only ever escalated to one that needs attention —
 * `requires_more`, `error`, `canceled`. An in-flight session is left alone
 * otherwise: a session sitting at `pending_authorization` (order placed, money
 * not yet in) must not be knocked back to `pending` by a routine PROCESSING
 * event, and `captured` is Medusa's to set once the workflow has run.
 */
async function writeStatus(
  paymentModule: IPaymentModuleService,
  session: PaymentSessionDTO,
  data: AfriexSessionData,
  forcedStatus?: PaymentSessionStatus
): Promise<void> {
  const mapped = forcedStatus ?? mapAfriexStatusToMedusaStatus(data.currentStatus)
  const escalates =
    mapped === "requires_more" || mapped === "error" || mapped === "canceled"

  await paymentModule.updatePaymentSession({
    id: session.id,
    data: data as unknown as Record<string, unknown>,
    amount: session.amount,
    currency_code: session.currency_code,
    ...(escalates ? { status: mapped } : {}),
  })
}

/**
 * Only a genuine miss is a miss. Any other failure — the database being
 * unreachable, most obviously — has to surface as a 500 so Afriex retries,
 * or the deposit is acknowledged and never reconciled.
 */
async function retrieveSession(
  paymentModule: IPaymentModuleService,
  sessionId: string
): Promise<PaymentSessionDTO | undefined> {
  try {
    return await paymentModule.retrievePaymentSession(sessionId)
  } catch (error) {
    if (
      MedusaError.isMedusaError(error) &&
      (error as MedusaError).type === MedusaError.Types.NOT_FOUND
    ) {
      return undefined
    }
    throw error
  }
}

function logUnmatched(
  logger: Logger,
  transaction: TransactionWebhookData,
  reason: string
): void {
  const message = `Afriex webhook for transaction ${String(transaction.transactionId)} ${reason}; ignoring.`

  if (isSettled(transaction.status)) {
    // Settled money with no session to attach it to is not noise. Someone has
    // to find where it belongs.
    logger.error(
      `${message} This deposit of ${transaction.destinationAmount} ${transaction.destinationCurrency} has SETTLED and is not attached to any order.`
    )
  } else {
    logger.info(message)
  }
}

function toExtraDeposit(transaction: TransactionWebhookData): AfriexExtraDeposit {
  return {
    transactionId: transaction.transactionId,
    amount: transaction.destinationAmount,
    currency: transaction.destinationCurrency?.toUpperCase(),
    receivedAt: transaction.updatedAt ?? new Date().toISOString(),
  }
}
