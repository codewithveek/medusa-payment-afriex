import {
  ContainerRegistrationKeys,
  Modules,
} from "@medusajs/framework/utils"
import type {
  MedusaNextFunction,
  MedusaRequest,
  MedusaResponse,
} from "@medusajs/framework/http"
import type { ILockingModule } from "@medusajs/framework/types"
import { buildCheckoutCustomer, type CheckoutPayer } from "./checkout-customer"
import { CheckoutErrorCode } from "./checkout-errors"
import {
  afriexCollectionLockKey,
  afriexMethodOf,
  isAfriexProviderId,
} from "./constants"
import { isFinalRecordedStatus } from "./map-status"
import { COLLECTION_LOCK_TIMEOUT_SECONDS, type GraphQuery } from "./reconciliation"
import type {
  AfriexCheckoutRequest,
  AfriexCheckoutSessionData,
  AfriexSessionBase,
} from "./types"

/** How long after Afriex last reported progress a payment still counts as moving. */
const IN_FLIGHT_WINDOW_MS = 30 * 60 * 1000

const TERMINAL_STATUSES = ["FAILED", "REJECTED", "CANCELLED"]
const PAYABLE_COLLECTION_STATUSES = ["not_paid", "awaiting"]

type Refusal = {
  status: number
  code: string
  message: string
  details?: Record<string, unknown>
}

type SessionRow = {
  id: string
  provider_id: string
  data?: Record<string, unknown> | null
}

type CollectionRow = {
  id: string
  status?: string
  payment_sessions?: SessionRow[]
}

type PayerRow = CheckoutPayer & {
  id: string
  region_id?: string | null
  completed_at?: string | Date | null
  status?: string | null
}

const PAYER_FIELDS = [
  "id",
  "email",
  "region_id",
  "customer.email",
  "customer.first_name",
  "customer.last_name",
  "customer.company_name",
  "customer.phone",
  "customer.addresses.*",
  "billing_address.*",
  "shipping_address.*",
]

/**
 * Stands in front of Medusa's `POST .../payment-collections/:id/payment-sessions`,
 * on the store and admin routes alike.
 *
 * Creating a payment session deletes every other session on the collection,
 * whichever provider the new one is for. So this runs for every provider, and
 * refuses to replace an Afriex session while money may still be moving
 * through it. For Afriex's own providers it also checks the order can still
 * be paid and that the method is still enabled in the order's region, which
 * Medusa does not check once the cart is completed. For hosted checkout it
 * builds the session data on the server — the stage, and the customer from
 * the cart or order — and throws away what the storefront sent.
 *
 * All of it runs under the collection's lock, held until the response is
 * sent, so two clicks on "Pay now" cannot each create a payment link and a
 * deposit is never recorded while its session is being replaced.
 */
export async function afriexPaymentSessionGuard(
  req: MedusaRequest,
  res: MedusaResponse,
  next: MedusaNextFunction
): Promise<void> {
  const collectionId = req.params?.id

  if (!collectionId) {
    next()
    return
  }

  const locking = req.scope.resolve<ILockingModule>(Modules.LOCKING)
  let failure: unknown

  try {
    await locking.execute(
      afriexCollectionLockKey(collectionId),
      async () => {
        let refusal: Refusal | undefined
        try {
          refusal = await prepare(req, collectionId)
        } catch (error) {
          failure = error
          return
        }

        if (refusal) {
          res
            .status(refusal.status)
            .json({ code: refusal.code, message: refusal.message, ...refusal.details })
          return
        }

        // Hold the lock until Medusa has created the session and answered.
        await new Promise<void>((resolve) => {
          res.once("finish", () => resolve())
          res.once("close", () => resolve())
          next()
        })
      },
      { timeout: COLLECTION_LOCK_TIMEOUT_SECONDS }
    )
  } catch {
    // Only a lock that could not be taken lands here: failures inside the job
    // are caught above. Another request or a webhook is working on this order.
    if (!res.headersSent) {
      res.status(409).json({
        code: CheckoutErrorCode.PAYMENT_IN_PROGRESS,
        message: "This order's payment is being updated. Please try again in a moment.",
      })
    }
    return
  }

  if (failure) {
    next(failure)
  }
}

async function prepare(req: MedusaRequest, collectionId: string): Promise<Refusal | undefined> {
  const query = req.scope.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const body = readBody(req)
  const requested = typeof body.provider_id === "string" ? body.provider_id : undefined

  const [collection] = (
    await query.graph({
      entity: "payment_collection",
      fields: [
        "id",
        "status",
        "payment_sessions.id",
        "payment_sessions.provider_id",
        "payment_sessions.data",
      ],
      filters: { id: collectionId },
    })
  ).data as unknown as CollectionRow[]

  if (!collection) {
    // Medusa answers for a collection that does not exist.
    return undefined
  }

  const inFlight = findPaymentInFlight(collection.payment_sessions ?? [])
  if (inFlight) {
    return inFlight
  }

  if (!isAfriexProviderId(requested)) {
    return undefined
  }

  const { cart, order } = await findPayer(query, collectionId)

  if (order || cart?.completed_at) {
    if (
      order?.status === "canceled" ||
      !PAYABLE_COLLECTION_STATUSES.includes(String(collection.status))
    ) {
      return {
        status: 400,
        code: CheckoutErrorCode.ORDER_NOT_PAYABLE,
        message: "This order is cancelled or already paid.",
      }
    }

    // Medusa checks a provider against the region only while the cart is
    // active. After that, a method an admin turned off could still be used to
    // pay an existing order.
    const regionId = order?.region_id ?? cart?.region_id
    if (regionId && !(await isEnabledInRegion(query, regionId, requested!))) {
      return {
        status: 400,
        code: CheckoutErrorCode.METHOD_UNAVAILABLE,
        message: "This payment option is no longer available. Please choose another.",
      }
    }
  }

  if (afriexMethodOf(requested) !== "checkout") {
    return undefined
  }

  const payer = order ?? cart
  const built = payer ? buildCheckoutCustomer(payer, undefined) : { missing: "email" as const }

  if ("missing" in built) {
    return built.missing === "email"
      ? {
          status: 400,
          code: CheckoutErrorCode.EMAIL_REQUIRED,
          message: "An email address is needed to pay online with Afriex.",
        }
      : {
          status: 400,
          code: CheckoutErrorCode.PHONE_REQUIRED,
          message: "A phone number, with its country, is needed to pay online with Afriex.",
        }
  }

  const instructions: AfriexCheckoutRequest = {
    stage: cart && !cart.completed_at ? "select" : "pay",
    customer: built.customer,
    channels: null,
    order_id: order?.id ?? null,
    cart_id: cart?.id ?? null,
    payment_collection_id: collectionId,
  }

  // Everything the storefront sent is dropped, except a return URL the
  // provider checks against the store's allowed origins.
  const returnUrl = (body.data as Record<string, unknown> | undefined)?.return_url
  const data: Record<string, unknown> = {
    ...(returnUrl !== undefined ? { return_url: returnUrl } : {}),
    afriex: instructions,
  }

  writeData(req, data)
  return undefined
}

/**
 * Whether an Afriex session on this collection may still be receiving money,
 * so replacing it — which deletes it — must wait. Anything else can be
 * replaced safely: every reference the plugin hands out is in its ledger, and
 * a late payment on one is held for its order.
 */
function findPaymentInFlight(sessions: SessionRow[]): Refusal | undefined {
  const now = Date.now()

  for (const session of sessions) {
    if (!isAfriexProviderId(session.provider_id)) {
      continue
    }

    const data = (session.data ?? {}) as Partial<AfriexSessionBase & AfriexCheckoutSessionData>

    if (isFinalRecordedStatus(data.currentStatus)) {
      return {
        status: 409,
        code: CheckoutErrorCode.PAYMENT_IN_PROGRESS,
        message: "A payment has already arrived for this order.",
        details: { payment_session_id: session.id },
      }
    }

    const lastEvent = data.lastEventAt ? Date.parse(data.lastEventAt) : NaN
    if (
      data.afriexTransactionId &&
      !TERMINAL_STATUSES.includes(String(data.currentStatus)) &&
      now - lastEvent < IN_FLIGHT_WINDOW_MS
    ) {
      return {
        status: 409,
        code: CheckoutErrorCode.PAYMENT_IN_PROGRESS,
        message: "A payment for this order is still being processed.",
        details: {
          payment_session_id: session.id,
          retry_after: new Date(lastEvent + IN_FLIGHT_WINDOW_MS).toISOString(),
        },
      }
    }

    const expiry = Date.parse(data.expiresAt ?? data.expiresAtEstimate ?? "")
    if (
      data.stage === "open" &&
      data.checkoutUrl &&
      !TERMINAL_STATUSES.includes(String(data.currentStatus)) &&
      now < expiry
    ) {
      return {
        status: 409,
        code: CheckoutErrorCode.PAYMENT_IN_PROGRESS,
        message: "Your payment link is still active. Continue on it, or try again once it expires.",
        details: {
          payment_session_id: session.id,
          checkout_url: data.checkoutUrl,
          retry_after: new Date(expiry).toISOString(),
        },
      }
    }
  }

  return undefined
}

async function findPayer(
  query: GraphQuery,
  collectionId: string
): Promise<{ cart?: PayerRow; order?: PayerRow }> {
  const cartId = (
    await query.graph({
      entity: "cart_payment_collection",
      fields: ["cart_id"],
      filters: { payment_collection_id: collectionId },
    })
  ).data[0]?.cart_id as string | undefined

  const cart = cartId
    ? ((
        await query.graph({
          entity: "cart",
          fields: [...PAYER_FIELDS, "completed_at"],
          filters: { id: cartId },
        })
      ).data[0] as PayerRow | undefined)
    : undefined

  let orderId = (
    await query.graph({
      entity: "order_payment_collection",
      fields: ["order_id"],
      filters: { payment_collection_id: collectionId },
    })
  ).data[0]?.order_id as string | undefined

  if (!orderId && cartId) {
    orderId = (
      await query.graph({
        entity: "order_cart",
        fields: ["order_id"],
        filters: { cart_id: cartId },
      })
    ).data[0]?.order_id as string | undefined
  }

  const order = orderId
    ? ((
        await query.graph({
          entity: "order",
          fields: [...PAYER_FIELDS, "status"],
          filters: { id: orderId },
        })
      ).data[0] as PayerRow | undefined)
    : undefined

  return { cart, order }
}

async function isEnabledInRegion(
  query: GraphQuery,
  regionId: string,
  providerId: string
): Promise<boolean> {
  const [region] = (
    await query.graph({
      entity: "region",
      fields: ["id", "payment_providers.id"],
      filters: { id: regionId },
    })
  ).data as { payment_providers?: { id: string }[] }[]

  return !!region?.payment_providers?.some((provider) => provider.id === providerId)
}

/** The store route reads `req.body`; the admin route reads `req.validatedBody`. */
function readBody(req: MedusaRequest): { provider_id?: unknown; data?: unknown } {
  return ((req as { validatedBody?: unknown }).validatedBody ?? req.body ?? {}) as {
    provider_id?: unknown
    data?: unknown
  }
}

function writeData(req: MedusaRequest, data: Record<string, unknown>): void {
  const request = req as { body?: Record<string, unknown>; validatedBody?: Record<string, unknown> }

  if (request.body && typeof request.body === "object") {
    request.body.data = data
  }
  if (request.validatedBody && typeof request.validatedBody === "object") {
    request.validatedBody.data = data
  }
}
