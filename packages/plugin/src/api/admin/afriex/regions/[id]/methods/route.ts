import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../../../lib/admin-error"
import { getRegionMethods, setRegionMethod } from "../../../../../../lib/region-methods"

type SetMethodBody = {
  provider_id?: unknown
  enabled?: unknown
  confirm_empty?: unknown
}

/** Which Afriex payment methods are on in this region. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  await respond(res, () => getRegionMethods(req.scope, req.params.id!))
}

/**
 * Turns one Afriex payment method on or off in this region, keeping every
 * other payment provider the region has.
 *
 * Body: `{ provider_id: string, enabled: boolean, confirm_empty?: boolean }`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<SetMethodBody>,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as SetMethodBody

  if (typeof body.provider_id !== "string" || typeof body.enabled !== "boolean") {
    res.status(400).json({
      code: "AFRIEX_INVALID_REQUEST",
      message: "`provider_id` (string) and `enabled` (boolean) are required.",
    })
    return
  }

  await respond(res, () =>
    setRegionMethod(req.scope, {
      regionId: req.params.id!,
      providerId: body.provider_id as string,
      enabled: body.enabled as boolean,
      confirmEmpty: body.confirm_empty === true,
    })
  )
}

async function respond(res: MedusaResponse, work: () => Promise<unknown>): Promise<void> {
  try {
    res.status(200).json(await work())
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message, ...error.details })
      return
    }
    throw error
  }
}
