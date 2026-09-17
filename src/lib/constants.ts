/** Medusa provider identifier. The fully-qualified id Medusa stores is `pp_afriex_<config id>`. */
export const AFRIEX_PROVIDER_IDENTIFIER = "afriex"

/** Path the plugin registers on the Medusa server for Afriex to call. */
export const AFRIEX_WEBHOOK_PATH = "/afriex/webhook"

/** Afriex webhook events this plugin acts on. Anything else is acknowledged and ignored. */
export const AFRIEX_TRANSACTION_EVENTS = [
  "TRANSACTION.CREATED",
  "TRANSACTION.UPDATED",
] as const

/**
 * Statuses the plugin writes into the payment session's `data.currentStatus`.
 * `AMOUNT_MISMATCH` is the plugin's own, not one Afriex ever sends — it marks a
 * confirmed deposit whose amount did not match what the order expected.
 */
export const AFRIEX_AMOUNT_MISMATCH = "AMOUNT_MISMATCH"
