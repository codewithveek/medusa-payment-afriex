import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError, resolveHeldSession } from "../../../../../../lib/held-payments"

type ResolveBody = {
  action?: unknown
  received_amount?: unknown
}

/**
 * Resolves money an Afriex payment session is holding without having captured
 * it — a wrong amount, an order total that changed, or an order that was
 * cancelled.
 *
 * Body: `{ action: "accept", received_amount: string }` to take the deposit as
 * payment in full, or `{ action: "refund" }` to record it as money to refund
 * and let the shopper pay again.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<ResolveBody>,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as ResolveBody

  if (body.action !== "accept" && body.action !== "refund") {
    res.status(400).json({
      code: "AFRIEX_INVALID_REQUEST",
      message: '`action` must be "accept" or "refund".',
    })
    return
  }

  const receivedAmount =
    typeof body.received_amount === "string" || typeof body.received_amount === "number"
      ? String(body.received_amount)
      : undefined

  try {
    const result = await resolveHeldSession(req.scope, {
      sessionId: req.params.id!,
      action: body.action,
      receivedAmount,
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
