import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../../../lib/admin-error"
import { getOrderPayment } from "../../../../../../lib/order-payment"

/** The Afriex sessions and references behind one order, for its widget. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  try {
    res.status(200).json(await getOrderPayment(req.scope, req.params.id!))
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message, ...error.details })
      return
    }
    throw error
  }
}
