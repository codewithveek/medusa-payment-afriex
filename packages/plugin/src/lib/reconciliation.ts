import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import {
  ContainerRegistrationKeys,
  Modules,
  PaymentActions,
  PaymentCollectionStatus,
} from "@medusajs/framework/utils"
import type {
  ILockingModule,
  IPaymentModuleService,
  Logger,
  MedusaContainer,
  PaymentSessionDTO,
  PaymentSessionStatus,
} from "@medusajs/framework/types"
import type { TransactionWebhookData } from "@afriex/sdk"
import {
  AFRIEX_SETTLED_AFTER_CANCEL,
  afriexCollectionLockKey,
  afriexMethodOf,
} from "./constants"
import { mapAfriexStatus } from "./map-status"
import type { AfriexExtraDeposit, AfriexSessionBase } from "./types"

/** The slice of Medusa's Query the plugin needs. */
export type GraphQuery = {
  graph(input: {
    entity: string
    fields: string[]
    /** Left out to read every row of an entity, as the settings page does for regions. */
    filters?: Record<string, unknown>
  }): Promise<{ data: Record<string, unknown>[] }>
}

/**
 * How long work on a payment collection waits for other work on the same
 * collection to finish. Kept short: Afriex gives a webhook 30 seconds in all,
 * and a capture can itself wait on the cart lock. A wait that runs out throws,
 * which a webhook answers with 500 and Afriex retries.
 */
export const COLLECTION_LOCK_TIMEOUT_SECONDS = 5

/**
 * Runs a job under the payment collection's lock. Everything that decides from,
 * or changes, the Afriex sessions of a collection goes through here — webhook
 * reconciliation and the admin actions alike — so no two of them ever act on
 * the same state at once.
 */
export async function withCollectionLock<T>(
  container: MedusaContainer,
  paymentCollectionId: string,
  job: () => Promise<T>
): Promise<T> {
  const locking = container.resolve<ILockingModule>(Modules.LOCKING)
  return locking.execute(afriexCollectionLockKey(paymentCollectionId), job, {
    timeout: COLLECTION_LOCK_TIMEOUT_SECONDS,
  })
}

/**
 * Records Afriex state onto the session.
 *
 * The session status is only ever escalated to one that needs attention —
 * `requires_more`, `error`, `canceled` — unless a caller that knows better
 * passes one. An in-flight session is left alone otherwise: a session sitting
 * at `pending_authorization` (order placed, money not yet in) must not be
 * knocked back to `pending` by a routine PROCESSING event, and `captured` is
 * Medusa's to set once the workflow has run.
 */
export async function writeStatus(
  paymentModule: IPaymentModuleService,
  session: PaymentSessionDTO,
  data: AfriexSessionBase,
  forcedStatus?: PaymentSessionStatus
): Promise<void> {
  const mapped =
    forcedStatus ??
    mapAfriexStatus(data.currentStatus, afriexMethodOf(session.provider_id) ?? "bank_transfer")
  const escalates =
    forcedStatus !== undefined ||
    mapped === "requires_more" ||
    mapped === "error" ||
    mapped === "canceled"

  await paymentModule.updatePaymentSession({
    id: session.id,
    data: data as unknown as Record<string, unknown>,
    amount: session.amount,
    currency_code: session.currency_code,
    ...(escalates ? { status: mapped } : {}),
  })
}

/**
 * Authorizes the session, captures the payment and completes the cart into an
 * order. Medusa owns that sequence; the plugin only reports the deposit. The
 * session's data must already say SUCCESS, which is what the provider's
 * authorization reads.
 *
 * Must run under the collection lock: Medusa's authorization reads the session
 * data when it starts and writes that same snapshot back when it ends.
 */
export async function captureSession(
  container: MedusaContainer,
  sessionId: string,
  amount: number,
  options: { firstCapture: boolean }
): Promise<"captured" | "settled_after_cancel"> {
  await processPaymentWorkflow(container).run({
    input: {
      action: PaymentActions.SUCCESSFUL,
      data: { session_id: sessionId, amount },
    },
  })

  // The workflow tolerates a great deal on the way through — a deferred
  // authorization, a cart that would not complete — and reports none of it.
  // Money has arrived; the only acceptable end state is a payment on this
  // session and an order behind it. Anything less is thrown, so the caller
  // can let the work be retried, and is logged each time so it cannot fail
  // quietly.
  await assertCaptured(container, sessionId)

  if (options.firstCapture) {
    return (await flagIfCanceledDuringCapture(container, sessionId)) ?? "captured"
  }
  return "captured"
}

async function assertCaptured(
  container: MedusaContainer,
  sessionId: string
): Promise<void> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const after = await paymentModule.retrievePaymentSession(sessionId, {
    relations: ["payment"],
  })

  if (!after.payment) {
    throw new Error(
      `deposit settled but no payment was recorded on session ${sessionId}`
    )
  }

  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)

  const { data: cartLinks } = await query.graph({
    entity: "cart_payment_collection",
    fields: ["cart_id"],
    filters: { payment_collection_id: after.payment_collection_id },
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
      `deposit settled and captured on session ${sessionId} but cart ${cartId} did not complete into an order`
    )
  }
}

/**
 * The cancelled-order check runs before the capture, and an admin can cancel
 * the order in between: cancelling does not take this plugin's lock, and with
 * no payment yet it has nothing to stop. The capture then lands on a cancelled
 * order. It cannot be undone here, but it must not pass for a normal sale
 * either, so it is flagged for a refund the same way.
 */
async function flagIfCanceledDuringCapture(
  container: MedusaContainer,
  sessionId: string
): Promise<"settled_after_cancel" | undefined> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const session = await paymentModule.retrievePaymentSession(sessionId)
  const order = await findOrder(container, session.payment_collection_id)

  if (!order || order.status !== "canceled") {
    return undefined
  }

  const data = (session.data ?? {}) as unknown as AfriexSessionBase

  // Only the record changes. The session already carries Medusa's own
  // authorized state, which a forced status here would contradict.
  await paymentModule.updatePaymentSession({
    id: session.id,
    data: { ...data, currentStatus: AFRIEX_SETTLED_AFTER_CANCEL } as unknown as Record<
      string,
      unknown
    >,
    amount: session.amount,
    currency_code: session.currency_code,
  })

  container
    .resolve<Logger>("logger")
    .error(
      `Afriex deposit ${String(data.afriexTransactionId)} was captured on session ${session.id}, but its order ${order.id} was cancelled while the capture ran. Needs a refund.`
    )

  return "settled_after_cancel"
}

export async function isPaidThroughAnotherSession(
  paymentModule: IPaymentModuleService,
  session: PaymentSessionDTO
): Promise<boolean> {
  const siblings = await paymentModule.listPaymentSessions(
    { payment_collection_id: session.payment_collection_id },
    { relations: ["payment"] }
  )
  return siblings.some((sibling) => sibling.id !== session.id && !!sibling.payment)
}

/**
 * Cancelled means the order says so, or the collection does. The collection
 * alone is not enough: Medusa recomputes a collection's status from its
 * sessions whenever one is authorized — the admin's "check status" action on
 * a pending session does it — and that overwrites `canceled` with `awaiting`.
 */
export async function isCanceled(
  container: MedusaContainer,
  paymentCollectionId: string,
  collection: { status?: string }
): Promise<boolean> {
  if (collection.status === PaymentCollectionStatus.CANCELED) {
    return true
  }

  const order = await findOrder(container, paymentCollectionId)
  return order?.status === "canceled"
}

export async function findOrder(
  container: MedusaContainer,
  paymentCollectionId: string
): Promise<{ id: string; status?: string } | undefined> {
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)

  const { data: links } = await query.graph({
    entity: "order_payment_collection",
    fields: ["order_id"],
    filters: { payment_collection_id: paymentCollectionId },
  })
  const orderId = links[0]?.order_id

  if (typeof orderId !== "string" || !orderId) {
    return undefined
  }

  const { data: orders } = await query.graph({
    entity: "order",
    fields: ["id", "status"],
    filters: { id: orderId },
  })

  return (orders[0] as { id: string; status?: string } | undefined) ?? { id: orderId }
}

export function toExtraDeposit(transaction: TransactionWebhookData): AfriexExtraDeposit {
  return {
    transactionId: transaction.transactionId,
    amount: transaction.destinationAmount,
    currency: transaction.destinationCurrency?.toUpperCase(),
    receivedAt: transaction.updatedAt ?? new Date().toISOString(),
  }
}
