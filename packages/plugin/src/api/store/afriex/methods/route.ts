import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../lib/admin-error"
import { describeRegionMethods } from "../../../../lib/region-methods"

/**
 * The Afriex methods a storefront should offer in a region: each one that is
 * turned on there, whether Afriex can collect the region's currency that way,
 * and — for Afriex Checkout — which options its page would show. A storefront
 * shows the methods that are both `enabled` and `available`.
 *
 * Query: `region_id`.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const regionId = req.query?.region_id

  if (typeof regionId !== "string" || !regionId) {
    res.status(400).json({
      code: "AFRIEX_INVALID_REQUEST",
      message: "`region_id` is required.",
    })
    return
  }

  try {
    res.status(200).json(await describeRegionMethods(req.scope, regionId))
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message })
      return
    }
    throw error
  }
}
