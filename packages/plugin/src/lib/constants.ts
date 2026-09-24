/** Medusa provider identifier for bank transfer. The fully-qualified id Medusa stores is `pp_afriex_<config id>`. */
export const AFRIEX_PROVIDER_IDENTIFIER = "afriex"

/** Medusa provider identifier for Afriex hosted checkout: `pp_afriex-checkout_<config id>`. */
export const AFRIEX_CHECKOUT_PROVIDER_IDENTIFIER = "afriex-checkout"

/**
 * Prefix every bank-transfer registration carries in the payment module.
 *
 * @deprecated It does not match the checkout provider. Use `isAfriexProviderId`
 * or `afriexMethodOf` instead.
 */
export const AFRIEX_PROVIDER_ID_PREFIX = `pp_${AFRIEX_PROVIDER_IDENTIFIER}_`

const AFRIEX_CHECKOUT_PROVIDER_ID_PREFIX = `pp_${AFRIEX_CHECKOUT_PROVIDER_IDENTIFIER}_`

/** The ways an Afriex provider collects money. */
export type AfriexMethod = "bank_transfer" | "checkout"

export const AFRIEX_METHODS: readonly AfriexMethod[] = ["bank_transfer", "checkout"]

/**
 * Which Afriex method a fully-qualified provider id belongs to, or undefined
 * when it is not an Afriex provider at all. The method is always derived from
 * the provider id, never from session data: session data is partly written by
 * the storefront and cannot be trusted to say what it is.
 */
export function afriexMethodOf(providerId: string | null | undefined): AfriexMethod | undefined {
  if (typeof providerId !== "string") {
    return undefined
  }
  if (providerId.startsWith(AFRIEX_PROVIDER_ID_PREFIX)) {
    return "bank_transfer"
  }
  if (providerId.startsWith(AFRIEX_CHECKOUT_PROVIDER_ID_PREFIX)) {
    return "checkout"
  }
  return undefined
}

export function isAfriexProviderId(providerId: string | null | undefined): boolean {
  return afriexMethodOf(providerId) !== undefined
}

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
 * The plugin's own status for money that settled after the order was
 * cancelled. It is never captured: capturing would mark a cancelled order
 * paid. The merchant holds the money and must refund it.
 */
export const AFRIEX_SETTLED_AFTER_CANCEL = "SETTLED_AFTER_CANCEL"

/**
 * The plugin's own status for money that settled after the order's total was
 * changed — an admin order edit, claim or exchange rewrites the payment
 * collection's amount in place but leaves the session, and so the account or
 * link the shopper paid, at the old one. The deposit matches the old total and
 * would otherwise be captured as if it settled the new one. It is held instead.
 */
export const AFRIEX_COLLECTION_AMOUNT_CHANGED = "COLLECTION_AMOUNT_CHANGED"

/**
 * Lock key for one payment collection. Everything that decides from, or
 * changes, the Afriex sessions of a collection runs under it: recording a
 * deposit, and replacing a session with another. It is per collection rather
 * than per session because creating a session deletes every other session on
 * the same collection, so the collection is the unit that has to hold still.
 */
export function afriexCollectionLockKey(paymentCollectionId: string): string {
  return `afriex:payment-collection:${paymentCollectionId}`
}

/** Emitted by a provider when it hands the shopper something payable, for the payment-reference ledger. */
export const AFRIEX_REFERENCE_CREATED = "afriex.payment_reference.created"

/** Emitted by a provider when Medusa deletes or cancels the session behind a reference. */
export const AFRIEX_REFERENCE_SUPERSEDED = "afriex.payment_reference.superseded"

/**
 * Days a processed-webhook row is kept before the pruning job removes it.
 * Long enough to outlive any retry window Afriex uses; replaying an older event
 * is harmless because settled sessions are never downgraded and capture is
 * idempotent.
 */
export const AFRIEX_PROCESSED_WEBHOOK_RETENTION_DAYS = 90
