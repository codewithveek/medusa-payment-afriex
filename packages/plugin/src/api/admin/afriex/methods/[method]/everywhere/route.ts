import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../../../lib/admin-error"
import { setMethodEverywhere } from "../../../../../../lib/method-everywhere"

type Body = { enabled?: unknown; confirm_empty?: unknown }

/**
 * Turns one Afriex method off in every region, or back on in exactly the
 * regions it was on when it was turned off.
 *
 * Body: `{ enabled: boolean, confirm_empty?: boolean }`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<Body>,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as Body

  if (typeof body.enabled !== "boolean") {
    res.status(400).json({
      code: "AFRIEX_INVALID_REQUEST",
      message: "`enabled` (boolean) is required.",
    })
    return
  }

  try {
    res.status(200).json(
      await setMethodEverywhere(req.scope, {
        method: req.params.method!,
        enabled: body.enabled,
        confirmEmpty: body.confirm_empty === true,
      })
    )
  } catch (error) {
    if (error instanceof AfriexAdminError) {
      res.status(error.status).json({ code: error.code, message: error.message, ...error.details })
      return
    }
    throw error
  }
}
