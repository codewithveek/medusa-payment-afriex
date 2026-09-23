import { Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { AFRIEX_PAYMENTS_MODULE } from "../modules/afriex-payments"
import type AfriexPaymentsModuleService from "../modules/afriex-payments/service"
import type { AfriexMethod } from "./constants"
import { isUniqueViolation } from "./db-errors"

export { AFRIEX_REFERENCE_CREATED, AFRIEX_REFERENCE_SUPERSEDED } from "./constants"

export type ReferenceCreatedEvent = {
  reference: string
  method: AfriexMethod
  payment_session_id: string
  /** Known to the checkout provider; looked up from the session otherwise. */
  payment_collection_id?: string | null
  amount: string
  currency_code: string
  account_id?: string | null
  amount_minor?: string | null
}

export type ReferenceSupersededEvent = {
  reference: string
}

export type LatePayment = {
  transaction_id: string
  amount: string
  currency?: string | null
  received_at: string
  status: "held" | "applied" | "refunded"
  /** Set when an admin applied it: the session it paid. */
  applied_to?: string | null
  resolved_by?: string | null
  resolved_at?: string | null
}

export type PaymentReferenceRow = {
  id: string
  reference: string
  method: AfriexMethod
  payment_session_id: string
  payment_collection_id: string | null
  amount: string
  currency_code: string
  account_id: string | null
  amount_minor: string | null
  afriex_session_id?: string | null
  expires_at?: Date | string | null
  superseded_at: Date | string | null
  late_payments: LatePayment[] | null
}

function resolveStore(container: MedusaContainer): AfriexPaymentsModuleService {
  return container.resolve(AFRIEX_PAYMENTS_MODULE)
}

/**
 * Records a reference the moment it is handed out. The session row already
 * exists at that point — Medusa inserts it before calling the provider — so
 * the payment collection can be read from it when the provider did not know it.
 */
export async function recordReference(
  container: MedusaContainer,
  event: ReferenceCreatedEvent
): Promise<void> {
  const store = resolveStore(container)
  let collectionId = event.payment_collection_id ?? null

  if (!collectionId) {
    try {
      const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
      const session = await paymentModule.retrievePaymentSession(event.payment_session_id, {
        select: ["id", "payment_collection_id"],
      })
      collectionId = session.payment_collection_id ?? null
    } catch {
      // The session is already gone — Medusa rolled it back after the provider
      // call. The reference is still worth keeping: an account was handed out.
    }
  }

  const values = {
    reference: event.reference,
    method: event.method,
    payment_session_id: event.payment_session_id,
    payment_collection_id: collectionId,
    amount: event.amount,
    currency_code: event.currency_code.toUpperCase(),
    account_id: event.account_id ?? null,
    amount_minor: event.amount_minor ?? null,
  }

  const existing = await findReference(container, event.reference)
  if (existing) {
    await store.updatePaymentReferences({ id: existing.id, ...values })
    return
  }

  try {
    await store.createPaymentReferences(values)
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error
    }
    // Recorded concurrently by another delivery of the same event.
    const raced = await findReference(container, event.reference)
    if (raced) {
      await store.updatePaymentReferences({ id: raced.id, ...values })
    }
  }
}

export async function supersedeReference(
  container: MedusaContainer,
  event: ReferenceSupersededEvent
): Promise<void> {
  const existing = await findReference(container, event.reference)
  if (existing && !existing.superseded_at) {
    await resolveStore(container).updatePaymentReferences({
      id: existing.id,
      superseded_at: new Date(),
    })
  }
}

/**
 * What `CHECKOUT_SESSION.CREATED` told us about a link. Kept on the ledger row
 * as well as the session, because the row outlives the session: a link paid
 * after its session was replaced is traced through here.
 */
export async function recordCheckoutSessionDetails(
  container: MedusaContainer,
  reference: string,
  details: { afriexSessionId?: string; expiresAt?: string }
): Promise<void> {
  const existing = await findReference(container, reference)
  if (!existing) {
    return
  }

  const expiresAt = details.expiresAt ? new Date(details.expiresAt) : undefined
  const values = {
    ...(details.afriexSessionId ? { afriex_session_id: details.afriexSessionId } : {}),
    ...(expiresAt && !Number.isNaN(expiresAt.getTime()) ? { expires_at: expiresAt } : {}),
  }

  if (Object.keys(values).length) {
    await resolveStore(container).updatePaymentReferences({ id: existing.id, ...values })
  }
}

export async function findReference(
  container: MedusaContainer,
  reference: string
): Promise<PaymentReferenceRow | undefined> {
  const [row] = await resolveStore(container).listPaymentReferences(
    { reference },
    { take: 1 }
  )
  return row as unknown as PaymentReferenceRow | undefined
}

export async function writeLatePayments(
  container: MedusaContainer,
  row: PaymentReferenceRow,
  latePayments: LatePayment[]
): Promise<void> {
  await resolveStore(container).updatePaymentReferences({
    id: row.id,
    late_payments: latePayments as unknown as Record<string, unknown>,
  })
}

/**
 * Claims a payment collection for one transaction before it is captured.
 *
 * - `claimed`: this transaction may capture — it is the first, or it is the
 *   same transaction retrying a capture that did not finish.
 * - otherwise: another transaction already paid this collection; the caller
 *   records this one as money to refund.
 */
export async function claimSettlement(
  container: MedusaContainer,
  input: { payment_collection_id: string; payment_session_id: string; transaction_id: string }
): Promise<{ claimed: true } | { claimed: false; by: string }> {
  const store = resolveStore(container)

  try {
    await store.createSettlements(input)
    return { claimed: true }
  } catch (error) {
    if (!isUniqueViolation(error)) {
      throw error
    }
  }

  const [existing] = await store.listSettlements(
    { payment_collection_id: input.payment_collection_id },
    { take: 1 }
  )

  if (!existing || existing.transaction_id === input.transaction_id) {
    return { claimed: true }
  }

  return { claimed: false, by: existing.transaction_id }
}
