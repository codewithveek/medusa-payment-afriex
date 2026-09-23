import { model } from "@medusajs/framework/utils"

/**
 * What an admin decided, for the whole store: which checkout options shoppers
 * are offered, and whether Afriex's own bank transfer is hidden where the
 * store already offers one of its own.
 *
 * There is exactly one row. `key` carries the constant that keeps it that way,
 * so two servers starting at once cannot each create their own.
 */
export const Setting = model.define("afriex_setting", {
  id: model.id({ prefix: "afxcfg" }).primaryKey(),
  key: model.text().unique(),
  /** The channels an admin allows. Null means "whatever the config allows". */
  checkout_channels: model.json().nullable(),
  /**
   * Drop checkout's bank-transfer option in regions that also offer the
   * plugin's own bank transfer — but only where another channel is known to
   * work for that currency, or the shopper would be left with nothing.
   */
  hide_bank_channel_where_bank_transfer: model.boolean().default(false),
  /** Regions an admin has paused. Recorded now; acted on by the settings page. */
  paused_regions: model.json().nullable(),
})
