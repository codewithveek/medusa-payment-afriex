import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { AfriexAdminError } from "../../../../lib/admin-error"
import {
  readAfriexSettings,
  writeAfriexSettings,
  type SettingsPatch,
} from "../../../../lib/settings"

/** What this store has decided about Afriex, store-wide. */
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse): Promise<void> {
  await respond(res, () => readAfriexSettings(req.scope))
}

/**
 * Saves the checkout options shoppers are offered and the hide-bank switch.
 * Only the fields sent are changed.
 *
 * Body: `{ checkout_channels?: string[] | null,
 *          hide_bank_channel_where_bank_transfer?: boolean,
 *          paused_regions?: string[] | null }`.
 */
export async function POST(
  req: AuthenticatedMedusaRequest<SettingsPatch>,
  res: MedusaResponse
): Promise<void> {
  const body = (req.body ?? {}) as SettingsPatch
  await respond(res, () => writeAfriexSettings(req.scope, body))
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
