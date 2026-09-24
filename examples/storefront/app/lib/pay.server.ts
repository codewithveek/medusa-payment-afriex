import {
  afriexMethodOf,
  medusa,
  providerIdOf,
  storeApi,
  type AfriexMethod,
} from "~/lib/medusa.server"

/**
 * What asking to pay can come back as. Every refusal the plugin sends carries a
 * stable `code`; this is the only place that reads it, and the rest of the app
 * branches on `kind`.
 */
export type PayResult =
  | { kind: "redirect"; url: string }
  | { kind: "placed" }
  | { kind: "in_progress"; url?: string; retryAfter?: string; message: string }
  | { kind: "not_payable"; message: string }
  | { kind: "unavailable"; message: string }
  | { kind: "needs_detail"; field: "email" | "phone"; message: string }
  | { kind: "try_again"; message: string }

/**
 * The order's payment collection a new payment goes on: the one still waiting,
 * not merely the first. An order edit can add a second.
 */
export async function payableCollectionId(orderId: string): Promise<string | undefined> {
  const { order } = await medusa.store.order.retrieve(orderId, {
    fields: "id,*payment_collections",
  })
  const collections = order.payment_collections ?? []
  return (
    collections.find((c) => ["not_paid", "awaiting"].includes(c.status ?? ""))?.id ??
    collections[0]?.id
  )
}

type SessionsResponse = {
  payment_collection: {
    payment_sessions?: { provider_id: string; data?: Record<string, unknown> }[]
  }
}

/** Asks for a payment session on a collection — the cart's, or a placed order's. */
export async function requestSession(
  collectionId: string,
  method: AfriexMethod
): Promise<PayResult> {
  const response = await storeApi<SessionsResponse>(
    `/store/payment-collections/${collectionId}/payment-sessions`,
    { method: "POST", body: { provider_id: providerIdOf(method) } }
  )

  if (!response.ok) {
    return fromRefusal(response.body)
  }

  const session = response.data.payment_collection.payment_sessions?.find(
    (s) => afriexMethodOf(s.provider_id) === method
  )
  const url = session?.data?.checkoutUrl
  return method === "checkout" && typeof url === "string"
    ? { kind: "redirect", url }
    : { kind: "placed" }
}

/**
 * Starts (or restarts) paying for a placed order.
 *
 * - Afriex Checkout: this is the pay stage. The plugin creates the payment link
 *   now, for this order, and the shopper is sent to it.
 * - Bank transfer: the plugin creates a virtual account; the order page shows it.
 */
export async function startPayment(orderId: string, method: AfriexMethod): Promise<PayResult> {
  const collectionId = await payableCollectionId(orderId)
  return collectionId
    ? requestSession(collectionId, method)
    : { kind: "not_payable", message: "This order has nothing left to pay." }
}

/** Turns a refusal from the store API into what the shopper should see and do. */
export function fromRefusal(body: Record<string, any>): PayResult {
  const message: string = body.message || "Payment could not be started. Please try again."

  switch (body.code) {
    case "AFRIEX_PAYMENT_IN_PROGRESS":
      return { kind: "in_progress", url: body.checkout_url, retryAfter: body.retry_after, message }
    case "AFRIEX_ORDER_NOT_PAYABLE":
      return { kind: "not_payable", message }
    case "AFRIEX_METHOD_UNAVAILABLE":
    case "AFRIEX_CHECKOUT_NOT_CONFIGURED":
    case "AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY":
    case "AFRIEX_CHECKOUT_REFUSED":
    case "AFRIEX_RETURN_URL_NOT_ALLOWED":
      return { kind: "unavailable", message }
    case "AFRIEX_CHECKOUT_EMAIL_REQUIRED":
      return { kind: "needs_detail", field: "email", message }
    case "AFRIEX_CHECKOUT_PHONE_REQUIRED":
      return { kind: "needs_detail", field: "phone", message }
    default:
      // AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE, a network failure, anything else.
      return { kind: "try_again", message }
  }
}
