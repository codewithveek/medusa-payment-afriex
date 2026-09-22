import { model } from "@medusajs/framework/utils"

export const ProcessedWebhook = model.define("afriex_processed_webhook", {
  id: model.id().primaryKey(),
  event_id: model.text().unique(),
  /** When the event was claimed. */
  processed_at: model.dateTime(),
  /** When processing finished. Null while the claiming delivery is still working on it. */
  completed_at: model.dateTime().nullable(),
})
