import {
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  Logger,
  MedusaContainer,
  PaymentSessionDTO,
} from "@medusajs/framework/types"
import type {
  CheckoutSessionWebhookPayload,
  TransactionWebhookData,
  TransactionWebhookPayload,
  WebhookPayload,
} from "@afriex/sdk"
import { amountsEqual, toAmountNumber } from "./amounts"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_PLUGIN_ROUTE_MARKER,
  AFRIEX_SETTLED_AFTER_CANCEL,
  afriexMethodOf,
  isAfriexProviderId,
  type AfriexMethod,
} from "./constants"
import { claimEvent, completeClaim, releaseClaim } from "./idempotency-store"
import {
  claimSettlement,
  findReference,
  recordCheckoutSessionDetails,
  writeLatePayments,
  type LatePayment,
  type PaymentReferenceRow,
} from "./ledger"
import { isFinalRecordedStatus, isSettled } from "./map-status"
import {
  captureSession,
  isCanceled,
  isPaidThroughAnotherSession,
  toExtraDeposit,
  withCollectionLock,
  writeStatus,
} from "./reconciliation"
import type {
  AfriexBankTransferSessionData,
  AfriexCheckoutSessionData,
  AfriexSessionBase,
  AfriexTransactionRecord,
} from "./types"
import { readSessionData } from "./session-data"
import {
  buildCheckoutSessionEventId,
  buildEventId,
  getSessionId,
  isCheckoutSessionEvent,
  isTransactionEvent,
  readCheckoutSessionEvent,
} from "./webhook-mapping"

export type WebhookResult = {
  success: boolean
  statusCode?: number
  error?: string
  /** What the handler did, surfaced for logs and tests. */
  outcome?:
    | "ignored"
    | "duplicate"
    | "unknown_session"
    | "held"
    | "captured"
    | "amount_mismatch"
    | "extra_deposit"
    | "settled_after_cancel"
    | "collection_amount_changed"
    | "status_recorded"
    | "checkout_session_recorded"
}

type Outcome = NonNullable<WebhookResult["outcome"]>

/** How far back the account-id fallback looks for a session. Dedicated accounts expire well inside this. */
const FALLBACK_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000
const FALLBACK_SCAN_LIMIT = 500

/**
 * The single path by which Afriex can change payment state in Medusa.
 *
 * Order of operations matters here. The signature is checked before the
 * payload is allowed to drive anything — no database read, no lookup keyed on
 * a value the sender chose. Signature verification is delegated to the
 * payment providers, which are the only components holding the webhook public
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

  if (isCheckoutSessionEvent(parsed)) {
    return processCheckoutSessionEvent(container, parsed, rawString, headers)
  }

  if (!isTransactionEvent(parsed)) {
    return { success: true, outcome: "ignored" }
  }

  const verified = await verifyWithAfriexProviders(
    paymentModule,
    parsed,
    rawString,
    headers
  )

  if (!verified.size) {
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
  // out the first — the deposit may still be perfectly attributable. When the
  // session itself is gone, the ledger may still know the reference.
  let session: PaymentSessionDTO | undefined
  let ledgerRow: PaymentReferenceRow | undefined
  try {
    session =
      (reference ? await retrieveSession(paymentModule, reference) : undefined) ??
      (await findSessionByAccount(paymentModule, verified, transaction))

    if (!session && reference) {
      ledgerRow = await findReference(container, reference)
    }
  } catch (error) {
    // Not a miss — the lookup itself failed. A 200 here would tell Afriex the
    // event was handled and end its retries.
    logger.error(
      `Afriex webhook for transaction ${String(transaction.transactionId)} could not be looked up: ${(error as Error).message}`
    )
    return { success: false, statusCode: 500, error: "Session lookup failed" }
  }

  if (!session && ledgerRow?.payment_collection_id && isSettled(transaction.status)) {
    // Bank transfer and checkout share one key, so a genuine event verifies
    // under the method the reference was handed out by.
    if (![...verified].some((id) => afriexMethodOf(id) === ledgerRow!.method)) {
      return { success: false, statusCode: 401, error: "Invalid signature" }
    }
    return runClaimed(
      container,
      buildEventId(parsed),
      `reference ${ledgerRow.reference}`,
      () => holdLatePayment(container, ledgerRow!, transaction)
    )
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

  // Bank transfer and checkout are separate providers holding the same Afriex
  // key, so an event verifies under both. What matters is that the provider
  // owning this session is one of those it verified under.
  if (!verified.has(session.provider_id)) {
    logger.warn(
      `Afriex webhook for session ${session.id} verified under ${[...verified].join(", ")}, but the session belongs to ${session.provider_id}.`
    )
    return { success: false, statusCode: 401, error: "Invalid signature" }
  }

  const found = session
  return runClaimed(container, buildEventId(parsed), `session ${found.id}`, () =>
    reconcile(container, found, parsed)
  )
}

/**
 * `CHECKOUT_SESSION.CREATED` is how the plugin learns when a payment link
 * really expires; until it arrives, expiry is an assumption. It never captures
 * and never compares amounts, whatever it carries — a payment reaches the order
 * through `TRANSACTION.*`, where the units are known.
 *
 * Afriex fires it in the same call that creates the session, which can beat the
 * pay request that is still saving the link and holding the order's lock. When
 * that happens the ledger takes what it can and Afriex is asked to retry.
 */
async function processCheckoutSessionEvent(
  container: MedusaContainer,
  parsed: CheckoutSessionWebhookPayload,
  rawString: string,
  headers: Record<string, unknown>
): Promise<WebhookResult> {
  const logger = container.resolve<Logger>("logger")
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  const verified = await verifyWithAfriexProviders(paymentModule, parsed, rawString, headers)
  if (!verified.size) {
    logger.warn("Afriex checkout-session webhook failed signature verification.")
    return { success: false, statusCode: 401, error: "Invalid signature" }
  }

  const event = readCheckoutSessionEvent(parsed.data)
  if (!event.merchantReference || (!event.expiresAt && !event.sessionId)) {
    // Nothing to attach, or nothing worth recording.
    return { success: true, outcome: "ignored" }
  }

  const reference = event.merchantReference

  return runClaimed(
    container,
    buildCheckoutSessionEventId(parsed),
    `checkout session ${event.sessionId ?? reference}`,
    async () => {
      // The ledger row is keyed by the reference and does not need the session,
      // so it is written first and survives a retry of everything after it.
      await recordCheckoutSessionDetails(container, reference, {
        afriexSessionId: event.sessionId,
        expiresAt: event.expiresAt,
      })

      const session = await retrieveSession(paymentModule, reference)
      if (!session || !verified.has(session.provider_id)) {
        throw new RetryLater("its payment session existed")
      }

      const read = readSessionData(session.provider_id, session.data)
      if (read?.method !== "checkout" || read.data.stage !== "open") {
        throw new RetryLater("its payment link was saved")
      }

      return withCollectionLock<Outcome>(container, session.payment_collection_id, async () => {
        // Re-read under the lock: the pay request may have finished writing.
        const fresh = (await retrieveSession(paymentModule, session.id)) ?? session
        const current = readSessionData(fresh.provider_id, fresh.data)?.data ?? read.data

        await paymentModule.updatePaymentSession({
          id: fresh.id,
          amount: fresh.amount,
          currency_code: fresh.currency_code,
          data: {
            ...current,
            ...(event.expiresAt ? { expiresAt: event.expiresAt } : {}),
            ...(event.sessionId ? { checkoutSessionId: event.sessionId } : {}),
          } as unknown as Record<string, unknown>,
        })

        return "checkout_session_recorded"
      })
    }
  )
}

/**
 * Thrown by work that arrived too early to finish. The claim is handed back and
 * Afriex is asked to retry, rather than being told the event is done.
 */
class RetryLater extends Error {}

/**
 * Runs the work for one event exactly once. The claim is taken before the work
 * starts, completed after it, and handed back if it fails so Afriex's retry can
 * try again.
 */
async function runClaimed(
  container: MedusaContainer,
  eventId: string,
  target: string,
  work: () => Promise<Outcome>
): Promise<WebhookResult> {
  const logger = container.resolve<Logger>("logger")
  const claim = await claimEvent(container, eventId)

  if (claim === "duplicate") {
    return { success: true, outcome: "duplicate" }
  }

  if (claim === "in_progress") {
    // An earlier delivery of this event is still being processed — Afriex
    // retries an attempt that outruns its 30 seconds while the attempt is still
    // running. A 200 here would end the retries, and if that attempt then
    // failed, nothing would ever process the deposit.
    return { success: false, statusCode: 503, error: "Event is already being processed" }
  }

  try {
    const outcome = await work()
    await completeClaim(container, eventId)
    return { success: true, outcome }
  } catch (error) {
    // An event that failed halfway must stay retryable, so the claim goes back.
    await releaseClaim(container, eventId)

    if (error instanceof RetryLater) {
      logger.info(
        `Afriex webhook for ${target} arrived before ${error.message}. Asked Afriex to deliver it again.`
      )
      return { success: false, statusCode: 503, error: "Not ready for this event yet" }
    }

    logger.error(
      `Afriex webhook reconciliation failed for ${target}: ${(error as Error).message}`
    )
    return { success: false, statusCode: 500, error: "Reconciliation failed" }
  }
}

type Decision =
  | { outcome: Exclude<Outcome, "captured"> }
  | {
      outcome: "capture"
      amount: number
      /** False when this is a redelivery of the settlement that already paid the session. */
      firstCapture: boolean
    }

/**
 * Everything runs under one lock per payment collection, capture included.
 * Two different transactions for one session — a second transfer, say — can
 * arrive at the same moment; without the lock both would read the session as
 * unpaid and one deposit would be silently absorbed into the other's capture.
 * With it, the second one reads the first one's SUCCESS and is recorded as an
 * extra deposit.
 *
 * The capture has to stay inside the lock too. Medusa's authorization reads
 * the session data at its start and writes that same snapshot back at its end,
 * so an extra deposit recorded in between would be erased. Holding both locks
 * cannot deadlock: the collection lock is always taken first, and nothing that
 * holds the cart lock goes on to take it.
 */
async function reconcile(
  container: MedusaContainer,
  session: PaymentSessionDTO,
  event: TransactionWebhookPayload
): Promise<Outcome> {
  return withCollectionLock(container, session.payment_collection_id, async () => {
    const decision = await decide(container, session.id, event)

    if (decision.outcome !== "capture") {
      return decision.outcome
    }

    return captureSession(container, session.id, decision.amount, {
      firstCapture: decision.firstCapture,
    })
  })
}

/**
 * Reads the session fresh — the copy the caller looked up may already be
 * stale by the time the lock is held — and records what Afriex reported.
 */
async function decide(
  container: MedusaContainer,
  sessionId: string,
  event: TransactionWebhookPayload
): Promise<Decision> {
  const logger = container.resolve<Logger>("logger")
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const session = await paymentModule.retrievePaymentSession(sessionId)
  const data = (session.data ?? {}) as unknown as AfriexSessionBase &
    Partial<Pick<AfriexCheckoutSessionData, "chargedAmount">>
  const transaction = event.data
  const method = afriexMethodOf(session.provider_id) ?? "bank_transfer"
  // What every write below records about this event, whatever it decides.
  const recorded: AfriexSessionBase = { ...data, ...describeTransaction(data, transaction, method) }

  if (!isSettled(transaction.status)) {
    // Progress events arrive out of order and in parallel. Once money has
    // moved behind a status, a straggling PROCESSING must not undo it.
    if (isFinalRecordedStatus(data.currentStatus)) {
      logger.info(
        `Afriex ${transaction.status} for session ${session.id} arrived after ${data.currentStatus}; left as is.`
      )
      return { outcome: "status_recorded" }
    }

    await writeStatus(paymentModule, session, {
      ...recorded,
      currentStatus: transaction.status,
      afriexTransactionId: transaction.transactionId,
    })
    return { outcome: "status_recorded" }
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
    return recordExtraDeposit(
      container,
      session,
      recorded,
      transaction,
      `which was already paid by ${data.afriexTransactionId}`
    )
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

  const receivedAmount = transaction.destinationAmount
  const receivedCurrency = transaction.destinationCurrency?.toUpperCase()

  // Money already captured through another session of this collection — a
  // second payment link the shopper also paid, say — is not a second sale.
  if (!alreadyPaid && (await isPaidThroughAnotherSession(paymentModule, session))) {
    return recordExtraDeposit(
      container,
      session,
      recorded,
      transaction,
      `but its payment collection ${session.payment_collection_id} was already paid through another session`
    )
  }

  const collection = await paymentModule.retrievePaymentCollection(
    session.payment_collection_id,
    { select: ["id", "status", "amount"] }
  )

  // Cancelling an order that is still waiting for money does not reach the
  // provider — there is no payment yet to cancel — so the session stays open
  // and the money can still arrive. Capturing it would mark a cancelled order
  // paid. It is held instead, for someone to refund. A redelivery of the
  // settlement that already paid the order is not new money and is left to the
  // idempotent capture below.
  if (!alreadyPaid && (await isCanceled(container, session.payment_collection_id, collection))) {
    await writeStatus(
      paymentModule,
      session,
      {
        ...recorded,
        currentStatus: AFRIEX_SETTLED_AFTER_CANCEL,
        receivedAmount,
        receivedCurrency,
        afriexTransactionId: transaction.transactionId,
        extraDeposits: carriedDeposits,
      },
      "requires_more"
    )

    logger.error(
      `Afriex deposit ${transaction.transactionId} of ${receivedAmount} ${receivedCurrency} settled on session ${session.id} after its order was cancelled. It was not captured. Needs a refund.`
    )

    return { outcome: "settled_after_cancel" }
  }

  // The order's total can change after the shopper was given an account or a
  // link — an admin order edit, claim or exchange rewrites the collection's
  // amount in place and leaves this session at the old one. Capturing now
  // would book a deposit sized for the old total as if it paid the new one.
  if (!alreadyPaid && !amountsEqual(session.amount, collection.amount)) {
    await writeStatus(
      paymentModule,
      session,
      {
        ...recorded,
        currentStatus: AFRIEX_COLLECTION_AMOUNT_CHANGED,
        receivedAmount,
        receivedCurrency,
        afriexTransactionId: transaction.transactionId,
        extraDeposits: carriedDeposits,
      },
      "requires_more"
    )

    logger.error(
      `Afriex deposit ${transaction.transactionId} of ${receivedAmount} ${receivedCurrency} settled on session ${session.id}, but the order total changed from ${toAmountNumber(session.amount)} to ${toAmountNumber(collection.amount)} after the shopper was asked to pay. It was not captured. Needs review.`
    )

    return { outcome: "collection_amount_changed" }
  }

  // Hosted checkout charged the session amount rounded to the currency's
  // minor unit; that rounded amount is what the shopper could pay.
  const expectedAmount =
    method === "checkout" && data.chargedAmount ? data.chargedAmount : toAmountNumber(session.amount)
  const expectedCurrency = session.currency_code.toUpperCase()

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
        ...recorded,
        currentStatus: AFRIEX_AMOUNT_MISMATCH,
        receivedAmount,
        receivedCurrency,
        afriexTransactionId: transaction.transactionId,
        extraDeposits: carriedDeposits,
      },
      "requires_more"
    )

    // Error level, like the other held cases: this is money the store holds
    // that no one will look at unless a person is told.
    logger.error(
      `Afriex deposit for session ${session.id} did not match: expected ${expectedAmount} ${expectedCurrency}, received ${receivedAmount} ${receivedCurrency}. Left for manual review.`
    )

    return { outcome: "amount_mismatch" }
  }

  // The database's word on who paid this collection, whatever lock the servers
  // share: a different transaction that got here first makes this one money
  // to refund, not a second capture.
  if (!alreadyPaid) {
    const settlement = await claimSettlement(container, {
      payment_collection_id: session.payment_collection_id,
      payment_session_id: session.id,
      transaction_id: transaction.transactionId,
    })

    if (!settlement.claimed) {
      return recordExtraDeposit(
        container,
        session,
        data,
        transaction,
        `but its payment collection ${session.payment_collection_id} was already settled by ${settlement.by}`
      )
    }
  }

  await writeStatus(paymentModule, session, {
    ...recorded,
    currentStatus: transaction.status,
    receivedAmount,
    receivedCurrency,
    afriexTransactionId: transaction.transactionId,
    paidChannel: transaction.channel ?? null,
    extraDeposits: carriedDeposits,
  })

  return {
    outcome: "capture",
    amount: toAmountNumber(receivedAmount),
    firstCapture: !alreadyPaid,
  }
}

async function recordExtraDeposit(
  container: MedusaContainer,
  session: PaymentSessionDTO,
  data: AfriexSessionBase,
  transaction: TransactionWebhookData,
  reason: string
): Promise<Decision> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  await writeStatus(paymentModule, session, {
    ...data,
    extraDeposits: [...(data.extraDeposits ?? []), toExtraDeposit(transaction)],
  })

  container
    .resolve<Logger>("logger")
    .error(
      `Afriex deposit ${transaction.transactionId} of ${transaction.destinationAmount} ${transaction.destinationCurrency} landed on session ${session.id}, ${reason}. Needs a refund.`
    )

  return { outcome: "extra_deposit" }
}

/**
 * A settled payment for a reference whose session Medusa has since deleted —
 * the cart changed, or the shopper switched method, after they had already
 * been given the account or link. The money is real. It is recorded against
 * the reference and held for an admin to apply to the order or refund.
 */
async function holdLatePayment(
  container: MedusaContainer,
  row: PaymentReferenceRow,
  transaction: TransactionWebhookData
): Promise<Outcome> {
  return withCollectionLock<Outcome>(container, row.payment_collection_id!, async () => {
    // Read again under the lock: another delivery may have just written it.
    const current = (await findReference(container, row.reference)) ?? row
    const late = current.late_payments ?? []

    if (late.some((payment) => payment.transaction_id === transaction.transactionId)) {
      return "held"
    }

    const entry: LatePayment = {
      transaction_id: transaction.transactionId,
      amount: transaction.destinationAmount,
      currency: transaction.destinationCurrency?.toUpperCase() ?? null,
      received_at: transaction.updatedAt ?? new Date().toISOString(),
      status: "held",
    }
    await writeLatePayments(container, current, [...late, entry])

    container
      .resolve<Logger>("logger")
      .error(
        `Afriex deposit ${transaction.transactionId} of ${transaction.destinationAmount} ${transaction.destinationCurrency} settled for reference ${row.reference}, whose payment session no longer exists (payment collection ${row.payment_collection_id}). It is held: apply it to the order or refund it.`
      )

    return "held"
  })
}

/** How many transactions a session keeps a record of. */
const TRANSACTION_HISTORY_LIMIT = 10

/**
 * What an event says about the payment beyond its status: the rail it used,
 * why it failed, and when — kept as a short history so a failed attempt
 * followed by a successful one does not erase the failure.
 */
function describeTransaction(
  data: AfriexSessionBase,
  transaction: TransactionWebhookData,
  method: AfriexMethod
): Partial<AfriexSessionBase> {
  const meta = (transaction.meta ?? {}) as Record<string, unknown>
  const failure = (meta.failureReason ?? undefined) as
    | { code?: string; message?: string; retryable?: boolean }
    | undefined
  const at = transaction.updatedAt ?? new Date().toISOString()
  const failed = transaction.status === "FAILED" || transaction.status === "REJECTED"

  const record: AfriexTransactionRecord = {
    transactionId: transaction.transactionId,
    status: transaction.status,
    channel: transaction.channel ?? null,
    amount: transaction.destinationAmount ?? null,
    ...(typeof meta.otpRequired === "boolean" ? { otpRequired: meta.otpRequired } : {}),
    at,
  }

  const transactions = [
    ...(data.transactions ?? []).filter(
      (earlier) =>
        !(earlier.transactionId === record.transactionId && earlier.status === record.status)
    ),
    record,
  ].slice(-TRANSACTION_HISTORY_LIMIT)

  // On Afriex's hosted bank-transfer page the shopper types the amount into
  // their own banking app. "The customer must send the exact amount shown.
  // Incorrect amounts may cause delays or require a refund." A failure there
  // may mean money was sent, so a person should look.
  const possibleWrongAmount =
    method === "checkout" &&
    failed &&
    transaction.channel === "VIRTUAL_BANK_ACCOUNT" &&
    (/AMOUNT/i.test(failure?.code ?? "") || Number(transaction.destinationAmount) > 0)

  return {
    lastEventAt: at,
    lastChannel: transaction.channel ?? data.lastChannel ?? null,
    transactions,
    failureReason: failed
      ? {
          code: typeof failure?.code === "string" ? failure.code : undefined,
          message: typeof failure?.message === "string" ? failure.message : undefined,
          retryable: typeof failure?.retryable === "boolean" ? failure.retryable : undefined,
          at,
        }
      : data.failureReason ?? null,
    needsAttention: possibleWrongAmount ? "possible_wrong_amount_transfer" : data.needsAttention ?? null,
  }
}

/**
 * Asks every registered Afriex provider whether the payload verifies under its
 * key, and returns the fully-qualified ids of those that say yes.
 *
 * Bank transfer and hosted checkout are separate providers built from one
 * configuration, so a genuine event normally verifies under both. Stopping at
 * the first would name whichever the database happened to list first, and the
 * other method's sessions would then be refused. The whole set is kept, and the
 * session's own provider must be in it.
 */
async function verifyWithAfriexProviders(
  paymentModule: IPaymentModuleService,
  parsed: WebhookPayload,
  rawString: string,
  headers: Record<string, unknown>
): Promise<Set<string>> {
  const providers = await paymentModule.listPaymentProviders(
    {},
    { select: ["id"] }
  )
  const verified = new Set<string>()

  for (const provider of providers) {
    if (!isAfriexProviderId(provider.id)) {
      continue
    }

    try {
      const result = await paymentModule.getWebhookActionAndData({
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

      if (result.action !== PaymentActions.NOT_SUPPORTED) {
        verified.add(provider.id)
      }
    } catch {
      // A registration the module could not resolve — one removed from the
      // config, say — cannot vouch for anything. Keep looking.
    }
  }

  return verified
}

/**
 * Deposits into a dedicated virtual account name that account as their
 * destination, and the plugin recorded which session the account was minted
 * for. That is a second, independent thread back to the cart when the
 * reference did not survive the trip. Only bank-transfer providers mint such
 * accounts, so only their sessions are scanned.
 */
async function findSessionByAccount(
  paymentModule: IPaymentModuleService,
  verified: Set<string>,
  transaction: TransactionWebhookData
): Promise<PaymentSessionDTO | undefined> {
  // A deposit "pulls funds from a source payment method", so the virtual
  // account is normally the transaction's source. Both ends are checked: a
  // payment method id identifies exactly one dedicated account either way.
  const accountIds = [transaction.sourceId, transaction.destinationId].filter(
    (id): id is string => typeof id === "string" && id.length > 0
  )
  const bankProviderIds = [...verified].filter(
    (id) => afriexMethodOf(id) === "bank_transfer"
  )

  if (!accountIds.length || !bankProviderIds.length) {
    return undefined
  }

  const since = new Date(Date.now() - FALLBACK_LOOKBACK_MS).toISOString()
  const candidates = await paymentModule.listPaymentSessions(
    { provider_id: bankProviderIds, created_at: { $gte: since } },
    { take: FALLBACK_SCAN_LIMIT, order: { created_at: "DESC" } }
  )

  return candidates.find((candidate) => {
    const data = candidate.data as unknown as Partial<AfriexBankTransferSessionData> | undefined
    return (
      data?.collectionMethod === "dedicated" &&
      typeof data.afriexPaymentMethodId === "string" &&
      accountIds.includes(data.afriexPaymentMethodId)
    )
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
