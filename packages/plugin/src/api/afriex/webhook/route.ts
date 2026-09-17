import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { processAfriexWebhook } from "../../../lib/webhook-handler"

export async function POST(
  req: MedusaRequest,
  res: MedusaResponse
): Promise<void> {
  if (!req.rawBody) {
    res.status(400).json({ error: "Missing raw request body" })
    return
  }

  const result = await processAfriexWebhook(
    req.scope,
    req.rawBody,
    req.headers as Record<string, unknown>
  )

  if (!result.success) {
    res.status(result.statusCode ?? 400).json({ error: result.error })
    return
  }

  res.status(200).json({ received: true, outcome: result.outcome })
}
