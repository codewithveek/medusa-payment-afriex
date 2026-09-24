import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../lib/admin-error"
import { getAfriexOverview } from "../../../../lib/overview"

/** Everything the Settings → Afriex page shows, in one call. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  try {
    res.status(200).json(await getAfriexOverview(req.scope))
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message, ...error.details })
      return
    }
    throw error
  }
}
