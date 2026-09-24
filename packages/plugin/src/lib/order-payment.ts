import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { afriexMethodOf, type AfriexMethod } from "./constants"
import { AFRIEX_PAYMENTS_MODULE } from "../modules/afriex-payments"
import type { LatePayment } from "./ledger"
import type { GraphQuery } from "./reconciliation"

export type OrderPaymentSession = {
  id: string
  provider_id: string
  method: AfriexMethod
  status: string
  amount: string
  currency_code: string
  data: Record<string, unknown>
}

export type OrderPaymentReference = {
  reference: string
  method: AfriexMethod
  payment_session_id: string
  superseded_at: string | null
  /** Money that arrived for this reference after its session was gone. */
  late_payments: LatePayment[]
}

export type OrderPayment = {
  order_id: string
  sessions: OrderPaymentSession[]
  references: OrderPaymentReference[]
}

/**
 * What the order page's widget needs beyond the order itself: every Afriex
 * session on the order, and every reference the plugin handed out for it —
 * including money held against a reference whose session is gone, which is the
 * only place that shows up.
 */
export async function getOrderPayment(
  container: MedusaContainer,
  orderId: string
): Promise<OrderPayment> {
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  const collectionIds = (
    (
      await query.graph({
        entity: "order_payment_collection",
        fields: ["payment_collection_id"],
        filters: { order_id: orderId },
      })
    ).data as { payment_collection_id?: string }[]
  )
    .map((link) => link.payment_collection_id)
    .filter((id): id is string => !!id)

  if (!collectionIds.length) {
    return { order_id: orderId, sessions: [], references: [] }
  }

  const sessions = (
    await paymentModule.listPaymentSessions(
      { payment_collection_id: collectionIds },
      { select: ["id", "provider_id", "status", "amount", "currency_code", "data"] }
    )
  ).flatMap((session) => {
    const method = afriexMethodOf(session.provider_id)
    return method
      ? [
          {
            id: session.id,
            provider_id: session.provider_id,
            method,
            status: String(session.status),
            amount: String(session.amount),
            currency_code: session.currency_code,
            data: (session.data ?? {}) as Record<string, unknown>,
          },
        ]
      : []
  })

  let references: OrderPaymentReference[] = []
  try {
    const rows = (await container
      .resolve<{ listPaymentReferences: Function }>(AFRIEX_PAYMENTS_MODULE)
      .listPaymentReferences({ payment_collection_id: collectionIds })) as {
      reference: string
      method: AfriexMethod
      payment_session_id: string
      superseded_at: string | Date | null
      late_payments: LatePayment[] | null
    }[]

    references = rows.map((row) => ({
      reference: row.reference,
      method: row.method,
      payment_session_id: row.payment_session_id,
      superseded_at: row.superseded_at ? new Date(row.superseded_at).toISOString() : null,
      late_payments: row.late_payments ?? [],
    }))
  } catch {
    // A store that has not run the migration yet still gets its sessions.
  }

  return { order_id: orderId, sessions, references }
}
