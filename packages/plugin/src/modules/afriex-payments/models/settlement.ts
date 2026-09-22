import { model } from "@medusajs/framework/utils"

/**
 * One row per payment collection that an Afriex deposit has paid. The unique
 * constraint on the collection is the backstop behind the plugin's lock: even
 * on servers that do not share a lock, two different deposits cannot both be
 * captured for the same order. The second one is recorded as money to refund.
 */
export const Settlement = model.define("afriex_settlement", {
  id: model.id({ prefix: "afxset" }).primaryKey(),
  payment_collection_id: model.text().unique(),
  payment_session_id: model.text(),
  transaction_id: model.text(),
})
