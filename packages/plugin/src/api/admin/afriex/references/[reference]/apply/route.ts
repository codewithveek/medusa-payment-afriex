import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { applyLatePayment, AfriexAdminError } from "../../../../../../lib/held-payments"

type ApplyBody = {
  transaction_id?: unknown
  confirm_amount?: unknown
  replace_session?: unknown
}

/**
 * Applies a held late payment to its order: money paid to a reference whose
 * payment session no longer exists.
 *
 * Body: `{ transaction_id: string, confirm_amount?: boolean, replace_session?: boolean }`.
 * `confirm_amount` is needed when the payment differs from what the order
 * expects; `replace_session` when the order has no single unpaid Afriex
 * session to record it on.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<ApplyBody>,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as ApplyBody

  if (typeof body.transaction_id !== "string" || !body.transaction_id) {
    res.status(400).json({
      code: "AFRIEX_INVALID_REQUEST",
      message: "`transaction_id` is required: the Afriex transaction to apply.",
    })
    return
  }

  try {
    const result = await applyLatePayment(req.scope, {
      reference: req.params.reference!,
      transactionId: body.transaction_id,
      confirmAmount: body.confirm_amount === true,
      replaceSession: body.replace_session === true,
      actorId: req.auth_context?.actor_id,
    })
    res.status(200).json(result)
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message, ...error.details })
      return
    }
    throw error
  }
}
