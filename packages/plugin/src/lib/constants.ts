/** Medusa provider identifier. The fully-qualified id Medusa stores is `pp_afriex_<config id>`. */
export const AFRIEX_PROVIDER_IDENTIFIER = "afriex"

/** Prefix every registration of this provider carries in the payment module. */
export const AFRIEX_PROVIDER_ID_PREFIX = `pp_${AFRIEX_PROVIDER_IDENTIFIER}_`

/** Path the plugin registers on the Medusa server for Afriex to call. */
export const AFRIEX_WEBHOOK_PATH = "/afriex/webhook"

/**
 * Set by the plugin's own webhook route on the headers it hands to the provider
 * for verification. Its absence tells the provider the event came in through
 * Medusa's generic `/hooks/payment/{provider}` endpoint instead, which cannot
 * process Afriex events safely and must say so rather than fail in silence.
 *
 * It carries no trust: a signature still has to verify either way. All it
 * decides is whether a wrongly registered webhook URL gets called out.
 */
export const AFRIEX_PLUGIN_ROUTE_MARKER = "x-afriex-plugin-route"

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

/**
 * Days a processed-webhook row is kept before the pruning job removes it.
 * Long enough to outlive any retry window Afriex uses; replaying an older event
 * is harmless because settled sessions are never downgraded and capture is
 * idempotent.
 */
export const AFRIEX_PROCESSED_WEBHOOK_RETENTION_DAYS = 90
