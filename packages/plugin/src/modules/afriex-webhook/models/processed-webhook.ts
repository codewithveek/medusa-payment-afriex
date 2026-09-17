import { model } from "@medusajs/framework/utils"

export const ProcessedWebhook = model.define("afriex_processed_webhook", {
  id: model.id().primaryKey(),
  event_id: model.text().unique(),
  processed_at: model.dateTime(),
})
