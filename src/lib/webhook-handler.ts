import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { Modules, PaymentActions } from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  Logger,
  MedusaContainer,
  PaymentSessionDTO,
  PaymentSessionStatus,
} from "@medusajs/framework/types"
import type { TransactionWebhookPayload, WebhookPayload } from "@afriex/sdk"
import { amountsEqual, toAmountNumber } from "./amounts"
import { AFRIEX_AMOUNT_MISMATCH } from "./constants"
import { claimEvent, releaseClaim } from "./idempotency-store"
import { isSettled, mapAfriexStatusToMedusaStatus } from "./map-status"
import type { AfriexSessionData } from "./types"
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
    | "status_recorded"
}

/**
 * The single path by which Afriex can change payment state in Medusa.
 *
 * Signature verification is delegated to the payment provider — it is the only
 * component holding the webhook public key — by asking the payment module to
 * map the event. A payload that does not verify comes back as `not_supported`
 * and is rejected before anything is read or written.
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

  const sessionId = getSessionId(parsed.data)

  if (!sessionId) {
    // Without a reference there is no cart this event can belong to. Guessing
    // would mean acting on an arbitrary order.
    logger.warn(
      `Afriex webhook for transaction ${parsed.data.transactionId} carried no reference; ignoring.`
    )
    return { success: true, outcome: "unknown_session" }
  }

  const session = await retrieveSession(paymentModule, sessionId)

  if (!session) {
    // Unrelated wallet activity or a test event — acknowledge so Afriex stops
    // retrying, but change nothing.
    logger.info(
      `Afriex webhook referenced unknown payment session ${sessionId}; ignoring.`
    )
    return { success: true, outcome: "unknown_session" }
  }

  const verified = await paymentModule.getWebhookActionAndData({
    provider: session.provider_id,
    payload: { data: parsed as unknown as Record<string, unknown>, rawData: rawString, headers },
  })

  if (verified.action === PaymentActions.NOT_SUPPORTED) {
    logger.warn(
      `Afriex webhook for session ${sessionId} failed signature verification.`
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
      `Afriex webhook reconciliation failed for session ${sessionId}: ${
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
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const data = (session.data ?? {}) as unknown as AfriexSessionData
  const transaction = event.data

  if (!isSettled(transaction.status)) {
    await writeStatus(paymentModule, session, {
      ...data,
      currentStatus: transaction.status,
      afriexTransactionId: transaction.transactionId,
    })
    return "status_recorded"
  }

  // From here the deposit has settled and only the amount stands between the
  // event and a captured order.

  const expectedAmount = toAmountNumber(session.amount)
  const receivedAmount = Number(transaction.destinationAmount)
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
        receivedAmount: transaction.destinationAmount,
        receivedCurrency,
        afriexTransactionId: transaction.transactionId,
      },
      "requires_more"
    )

    container
      .resolve<Logger>("logger")
      .warn(
        `Afriex deposit for session ${session.id} did not match: expected ${expectedAmount} ${expectedCurrency}, received ${receivedAmount} ${receivedCurrency}. Left for manual review.`
      )

    return "amount_mismatch"
  }

  await writeStatus(paymentModule, session, {
    ...data,
    currentStatus: transaction.status,
    receivedAmount: transaction.destinationAmount,
    receivedCurrency,
    afriexTransactionId: transaction.transactionId,
  })

  // Authorizes the session, captures the payment, and completes the cart into
  // an order. Medusa owns that sequence; the plugin only reports the deposit.
  await processPaymentWorkflow(container).run({
    input: {
      action: PaymentActions.SUCCESSFUL,
      data: { session_id: session.id, amount: receivedAmount },
    },
  })

  return "captured"
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

async function retrieveSession(
  paymentModule: IPaymentModuleService,
  sessionId: string
): Promise<PaymentSessionDTO | undefined> {
  try {
    return await paymentModule.retrievePaymentSession(sessionId)
  } catch {
    return undefined
  }
}
