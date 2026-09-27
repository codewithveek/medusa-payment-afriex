import type {
  CheckoutSessionWebhookData,
  CheckoutSessionWebhookPayload,
  TransactionWebhookData,
  TransactionWebhookPayload,
  WebhookPayload,
} from "@afriex/sdk"
import { stripSandboxHint } from "./sandbox"

export function isTransactionEvent(
  payload: WebhookPayload
): payload is TransactionWebhookPayload {
  return (
    payload.event === "TRANSACTION.CREATED" ||
    payload.event === "TRANSACTION.UPDATED"
  )
}

export function isCheckoutSessionEvent(
  payload: WebhookPayload
): payload is CheckoutSessionWebhookPayload {
  return payload.event === "CHECKOUT_SESSION.CREATED"
}

/** What the plugin takes from a checkout-session event, and nothing else. */
export type CheckoutSessionEvent = {
  /** Afriex's own id for the hosted session. */
  sessionId?: string
  /** The reference the plugin sent, which is its payment session's id. */
  merchantReference?: string
  /** When the payment link stops accepting payment. The reason this event is read at all. */
  expiresAt?: string
  /** Present once the session has been paid. Recorded, never acted on. */
  paidAt?: string
}

/**
 * The SDK types this payload as an open record, so every field is read
 * defensively. The money fields are deliberately not read: this event never
 * moves payment state, because its `amount` units are not documented and a
 * `TRANSACTION.*` event carries the same payment with units the plugin knows.
 */
export function readCheckoutSessionEvent(
  data: CheckoutSessionWebhookData
): CheckoutSessionEvent {
  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value ? value : undefined

  const merchantReference = text(data.merchantReference)

  return {
    sessionId: text(data.sessionId),
    // In staging the reference may carry sandbox control words after the id.
    merchantReference: merchantReference ? stripSandboxHint(merchantReference) : undefined,
    expiresAt: text(data.expiresAt),
    paidAt: text(data.paidAt),
  }
}

/**
 * Afriex re-sends this event after the session is paid, with `paidAt` set, so
 * the paid delivery must not collapse onto the unpaid one — each carries
 * something the plugin has not recorded yet.
 */
export function buildCheckoutSessionEventId(
  payload: CheckoutSessionWebhookPayload
): string {
  const { merchantReference, sessionId, paidAt } = readCheckoutSessionEvent(payload.data)
  return `${payload.event}:${merchantReference ?? "-"}:${sessionId ?? "-"}:${paidAt ?? "-"}`
}

/**
 * The Medusa payment session id. The plugin sets it as the Afriex `reference`
 * when the collection account is created, and Afriex echoes it back on every
 * transaction against that account — `merchantReference` mirrors the reference
 * from the create request, with `meta.reference` as the older spelling.
 *
 * Without it an event cannot be tied to a cart, and the plugin refuses to guess.
 * In staging the reference may carry sandbox control words after the id
 * (`payses_…--SIMULATE_INSTANT_FAIL`); they are removed here.
 */
export function getSessionId(data: TransactionWebhookData): string | undefined {
  const reference = data.merchantReference ?? data.meta?.reference
  return typeof reference === "string" ? stripSandboxHint(reference) : reference
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
