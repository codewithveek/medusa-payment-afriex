import type {
  TransactionWebhookData,
  TransactionWebhookPayload,
  WebhookPayload,
} from "@afriex/sdk"

export function isTransactionEvent(
  payload: WebhookPayload
): payload is TransactionWebhookPayload {
  return (
    payload.event === "TRANSACTION.CREATED" ||
    payload.event === "TRANSACTION.UPDATED"
  )
}

/**
 * The Medusa payment session id. The plugin sets it as the Afriex `reference`
 * when the collection account is created, and Afriex echoes it back on every
 * transaction against that account — `merchantReference` mirrors the reference
 * from the create request, with `meta.reference` as the older spelling.
 *
 * Without it an event cannot be tied to a cart, and the plugin refuses to guess.
 */
export function getSessionId(data: TransactionWebhookData): string | undefined {
  return data.merchantReference ?? data.meta?.reference
}

/**
 * A stable identity for one delivered event, built from the payload rather than
 * a delivery header so that a redelivery of the same state change collapses
 * onto the same id. Status is part of it: PENDING → SUCCESS for one transaction
 * are two distinct events that must both be processed.
 */
export function buildEventId(payload: TransactionWebhookPayload): string {
  const { transactionId, status, updatedAt } = payload.data
  return `${payload.event}:${transactionId}:${status}:${updatedAt}`
}
