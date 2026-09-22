import { createPaymentSessionsWorkflow } from "@medusajs/medusa/core-flows"
import { MathBN, MedusaError, Modules } from "@medusajs/framework/utils"
import type {
  IPaymentModuleService,
  MedusaContainer,
  PaymentSessionDTO,
} from "@medusajs/framework/types"
import { amountsEqual, toAmountNumber, toAmountString } from "./amounts"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_SETTLED_AFTER_CANCEL,
  afriexMethodOf,
  isAfriexProviderId,
} from "./constants"
import { claimSettlement, findReference, writeLatePayments } from "./ledger"
import { isFinalRecordedStatus } from "./map-status"
import {
  captureSession,
  findOrder,
  isCanceled,
  isPaidThroughAnotherSession,
  withCollectionLock,
  writeStatus,
} from "./reconciliation"
import type { AfriexExtraDeposit, AfriexSessionBase } from "./types"
import { AfriexAdminError } from "./admin-error"

export { AfriexAdminError }


/** Statuses that mean money arrived and was deliberately not captured. */
const HELD_STATUSES = [
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_SETTLED_AFTER_CANCEL,
]

const PAYABLE_COLLECTION_STATUSES = ["not_paid", "awaiting"]

/**
 * Applies a held late payment — money paid to a reference whose session is
 * gone — to its order.
 *
 * Medusa's own "mark as paid" cannot do this: it refuses any collection that
 * is not `not_paid`, and a collection waiting on an Afriex payment is
 * `awaiting`. So the payment is recorded on the collection's current Afriex
 * session and captured through it, exactly as a webhook would have.
 */
export async function applyLatePayment(
  container: MedusaContainer,
  input: {
    reference: string
    transactionId: string
    /** Required when the payment differs from what the order expects. */
    confirmAmount?: boolean
    /**
     * When the order has no single unpaid Afriex session, replace its sessions
     * with a hosted-checkout placeholder — one that never reaches Afriex — and
     * apply the payment to that.
     */
    replaceSession?: boolean
    actorId?: string
  }
): Promise<{ outcome: "captured" | "settled_after_cancel"; payment_session_id: string }> {
  const row = await findReference(container, input.reference)

  if (!row) {
    throw new AfriexAdminError("AFRIEX_REFERENCE_NOT_FOUND", 404, `No Afriex payment reference ${input.reference}.`)
  }

  if (!row.payment_collection_id) {
    throw new AfriexAdminError(
      "AFRIEX_REFERENCE_WITHOUT_ORDER",
      409,
      `Reference ${input.reference} is not linked to a payment collection, so there is no order to apply it to.`
    )
  }

  const collectionId = row.payment_collection_id
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  return withCollectionLock(container, collectionId, async () => {
    const current = (await findReference(container, input.reference)) ?? row
    const late = current.late_payments ?? []
    const entry = late.find((payment) => payment.transaction_id === input.transactionId)

    if (!entry) {
      throw new AfriexAdminError(
        "AFRIEX_LATE_PAYMENT_NOT_FOUND",
        404,
        `No late payment ${input.transactionId} is recorded for reference ${input.reference}.`
      )
    }

    if (entry.status !== "held") {
      throw new AfriexAdminError(
        "AFRIEX_LATE_PAYMENT_NOT_HELD",
        409,
        `Late payment ${input.transactionId} is already ${entry.status}.`
      )
    }

    const collection = await paymentModule.retrievePaymentCollection(collectionId, {
      select: ["id", "status", "amount"],
    })

    if (
      (await isCanceled(container, collectionId, collection)) ||
      !PAYABLE_COLLECTION_STATUSES.includes(String(collection.status))
    ) {
      throw new AfriexAdminError(
        "AFRIEX_ORDER_NOT_PAYABLE",
        409,
        "This order is cancelled or already paid. Refund the payment from your Afriex dashboard instead.",
        { collection_status: collection.status }
      )
    }

    const order = await findOrder(container, collectionId)
    const target = await findApplyTarget(container, collectionId, entry.transaction_id, {
      replaceSession: input.replaceSession === true,
      orderId: order?.id ?? null,
    })

    if (entry.currency && entry.currency !== target.currency_code.toUpperCase()) {
      throw new AfriexAdminError(
        "AFRIEX_CURRENCY_DIFFERS",
        409,
        `The payment was in ${entry.currency} but the order is in ${target.currency_code.toUpperCase()}.`
      )
    }

    if (!amountsEqual(entry.amount, target.amount) && !input.confirmAmount) {
      throw new AfriexAdminError(
        "AFRIEX_AMOUNT_DIFFERS",
        409,
        "The payment does not match what the order expects. Confirm to accept it as payment in full.",
        { received: entry.amount, expected: toAmountString(target.amount) }
      )
    }

    const settlement = await claimSettlement(container, {
      payment_collection_id: collectionId,
      payment_session_id: target.id,
      transaction_id: entry.transaction_id,
    })

    if (!settlement.claimed) {
      throw new AfriexAdminError(
        "AFRIEX_ALREADY_SETTLED",
        409,
        `This order was already paid by ${settlement.by}. Refund the payment from your Afriex dashboard instead.`
      )
    }

    const data = (target.data ?? {}) as unknown as AfriexSessionBase

    await writeStatus(paymentModule, target, {
      ...data,
      currentStatus: "SUCCESS",
      receivedAmount: entry.amount,
      receivedCurrency: entry.currency ?? null,
      afriexTransactionId: entry.transaction_id,
      paidViaReference: current.reference,
      resolvedBy: input.actorId ?? null,
      resolvedAt: new Date().toISOString(),
    })

    const outcome = await captureSession(container, target.id, toAmountNumber(target.amount), {
      firstCapture: true,
    })

    await writeLatePayments(
      container,
      current,
      late.map((payment) =>
        payment.transaction_id === entry.transaction_id
          ? {
              ...payment,
              status: "applied",
              applied_to: target.id,
              resolved_by: input.actorId ?? null,
              resolved_at: new Date().toISOString(),
            }
          : payment
      )
    )

    return { outcome, payment_session_id: target.id }
  })
}

/**
 * The session a late payment is applied to: the collection's one unpaid Afriex
 * session. An earlier attempt that recorded this same payment but did not get
 * as far as the capture counts too, so the admin can simply retry.
 *
 * When there is no such session — the shopper switched to another provider, or
 * there are several — the admin may confirm replacing them with a placeholder
 * hosted-checkout session, which never reaches Afriex.
 */
async function findApplyTarget(
  container: MedusaContainer,
  collectionId: string,
  transactionId: string,
  options: { replaceSession: boolean; orderId: string | null }
): Promise<PaymentSessionDTO> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const sessions = await paymentModule.listPaymentSessions(
    { payment_collection_id: collectionId },
    { relations: ["payment"] }
  )

  const candidates = sessions.filter((session) => {
    if (!isAfriexProviderId(session.provider_id) || session.payment) {
      return false
    }
    const data = (session.data ?? {}) as Partial<AfriexSessionBase>
    return (
      !isFinalRecordedStatus(data.currentStatus) ||
      (data.currentStatus === "SUCCESS" && data.afriexTransactionId === transactionId)
    )
  })

  if (candidates.length === 1) {
    return candidates[0]!
  }

  const checkoutProvider = options.replaceSession
    ? (await paymentModule.listPaymentProviders({}, { select: ["id"] })).find(
        (provider) => afriexMethodOf(provider.id) === "checkout"
      )
    : undefined

  if (!checkoutProvider) {
    throw new AfriexAdminError(
      "AFRIEX_NO_TARGET_SESSION",
      409,
      options.replaceSession
        ? "The order has no single unpaid Afriex payment session, and Afriex Checkout is not registered to create one."
        : "The order has no single unpaid Afriex payment session. Confirm with replace_session to replace its sessions and apply the payment.",
      {
        sessions: sessions.map((session) => ({
          id: session.id,
          provider_id: session.provider_id,
        })),
      }
    )
  }

  // Creating a session deletes the collection's other sessions; the admin
  // confirmed that. The placeholder makes no call to Afriex.
  const { result } = await createPaymentSessionsWorkflow(container).run({
    input: {
      payment_collection_id: collectionId,
      provider_id: checkoutProvider.id,
      data: { afriex: { stage: "select", purpose: "apply", order_id: options.orderId } },
    },
  })

  return paymentModule.retrievePaymentSession(result.id)
}

/**
 * Resolves money that arrived on a session but was deliberately not captured:
 * an amount that did not match, an order whose total changed, or an order that
 * was cancelled.
 *
 * - `accept` treats the deposit as payment in full. Medusa captures the
 *   session's amount; anything received beyond it is recorded to refund.
 * - `refund` records the deposit as money to refund from the Afriex dashboard
 *   and puts the session back to waiting, so the shopper can pay again.
 */
export async function resolveHeldSession(
  container: MedusaContainer,
  input: {
    sessionId: string
    action: "accept" | "refund"
    /** For `accept`: the admin confirms the amount that arrived. */
    receivedAmount?: string
    actorId?: string
  }
): Promise<{ outcome: "captured" | "settled_after_cancel" | "refund_recorded" }> {
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const session = await retrieveOrNotFound(paymentModule, input.sessionId)

  if (!isAfriexProviderId(session.provider_id)) {
    throw new AfriexAdminError(
      "AFRIEX_NOT_AN_AFRIEX_SESSION",
      400,
      `Payment session ${input.sessionId} does not belong to Afriex.`
    )
  }

  return withCollectionLock(container, session.payment_collection_id, async () => {
    const fresh = await paymentModule.retrievePaymentSession(input.sessionId)
    const data = (fresh.data ?? {}) as unknown as AfriexSessionBase

    if (!HELD_STATUSES.includes(data.currentStatus) || !data.receivedAmount || !data.afriexTransactionId) {
      throw new AfriexAdminError(
        "AFRIEX_NOTHING_HELD",
        409,
        `Payment session ${input.sessionId} is not holding a payment (status ${String(data.currentStatus)}).`
      )
    }

    const now = new Date().toISOString()

    if (input.action === "refund") {
      const cancelled = data.currentStatus === AFRIEX_SETTLED_AFTER_CANCEL
      const refundLine: AfriexExtraDeposit = {
        transactionId: data.afriexTransactionId,
        amount: data.receivedAmount,
        currency: data.receivedCurrency ?? null,
        receivedAt: now,
        reason: "refund",
      }
      // Back to waiting — pending authorization when an order was already
      // placed, which is how the session looked before the money arrived.
      const order = cancelled ? undefined : await findOrder(container, fresh.payment_collection_id)

      await writeStatus(
        paymentModule,
        fresh,
        {
          ...data,
          currentStatus: cancelled ? "CANCELLED" : "PENDING",
          receivedAmount: null,
          receivedCurrency: null,
          afriexTransactionId: null,
          extraDeposits: [...(data.extraDeposits ?? []), refundLine],
          resolvedBy: input.actorId ?? null,
          resolvedAt: now,
        },
        cancelled ? "canceled" : order ? "pending_authorization" : "pending"
      )

      return { outcome: "refund_recorded" as const }
    }

    if (data.currentStatus === AFRIEX_SETTLED_AFTER_CANCEL) {
      throw new AfriexAdminError(
        "AFRIEX_ORDER_CANCELLED",
        409,
        "This order was cancelled. The payment can only be refunded."
      )
    }

    if (!input.receivedAmount || !amountsEqual(input.receivedAmount, data.receivedAmount)) {
      throw new AfriexAdminError(
        "AFRIEX_CONFIRM_RECEIVED_AMOUNT",
        400,
        "Confirm the amount that arrived to accept it.",
        { received: data.receivedAmount, currency: data.receivedCurrency }
      )
    }

    if ((data.receivedCurrency ?? "").toUpperCase() !== fresh.currency_code.toUpperCase()) {
      throw new AfriexAdminError(
        "AFRIEX_CURRENCY_DIFFERS",
        409,
        `The payment was in ${String(data.receivedCurrency)} but the order is in ${fresh.currency_code.toUpperCase()}. Refund it instead.`
      )
    }

    const collection = await paymentModule.retrievePaymentCollection(fresh.payment_collection_id, {
      select: ["id", "status", "amount"],
    })

    if (
      (await isCanceled(container, fresh.payment_collection_id, collection)) ||
      !PAYABLE_COLLECTION_STATUSES.includes(String(collection.status))
    ) {
      throw new AfriexAdminError(
        "AFRIEX_ORDER_NOT_PAYABLE",
        409,
        "This order is cancelled or already paid. Refund the payment instead.",
        { collection_status: collection.status }
      )
    }

    if (await isPaidThroughAnotherSession(paymentModule, fresh)) {
      throw new AfriexAdminError(
        "AFRIEX_ALREADY_SETTLED",
        409,
        "This order was already paid through another payment session. Refund this payment instead."
      )
    }

    const settlement = await claimSettlement(container, {
      payment_collection_id: fresh.payment_collection_id,
      payment_session_id: fresh.id,
      transaction_id: data.afriexTransactionId,
    })

    if (!settlement.claimed) {
      throw new AfriexAdminError(
        "AFRIEX_ALREADY_SETTLED",
        409,
        `This order was already paid by ${settlement.by}. Refund this payment instead.`
      )
    }

    // Medusa captures the session's own amount. What arrived beyond it is the
    // merchant's to give back.
    const excess = MathBN.sub(MathBN.convert(data.receivedAmount), MathBN.convert(fresh.amount))
    const extraDeposits = MathBN.gt(excess, 0)
      ? [
          ...(data.extraDeposits ?? []),
          {
            transactionId: data.afriexTransactionId,
            amount: toAmountString(excess),
            currency: data.receivedCurrency ?? null,
            receivedAt: now,
            reason: "excess",
          },
        ]
      : data.extraDeposits

    await writeStatus(paymentModule, fresh, {
      ...data,
      currentStatus: "SUCCESS",
      extraDeposits,
      resolvedBy: input.actorId ?? null,
      resolvedAt: now,
    })

    const outcome = await captureSession(container, fresh.id, toAmountNumber(fresh.amount), {
      firstCapture: true,
    })

    return { outcome }
  })
}

async function retrieveOrNotFound(
  paymentModule: IPaymentModuleService,
  sessionId: string
): Promise<PaymentSessionDTO> {
  try {
    return await paymentModule.retrievePaymentSession(sessionId)
  } catch (error) {
    if (MedusaError.isMedusaError(error) && (error as MedusaError).type === MedusaError.Types.NOT_FOUND) {
      throw new AfriexAdminError("AFRIEX_SESSION_NOT_FOUND", 404, `No payment session ${sessionId}.`)
    }
    throw error
  }
}
