import Medusa from "@medusajs/js-sdk"

/**
 * Server-only Medusa client. Every call in this app runs inside a loader or an
 * action, so the publishable key stays on the server.
 */
const BACKEND_URL = (process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000").replace(/\/+$/, "")

export const medusa = new Medusa({
  baseUrl: BACKEND_URL,
  publishableKey: requireEnv("MEDUSA_PUBLISHABLE_KEY"),
})

/** The provider ids Medusa stores: `pp_<identifier>_<config id>`. */
export const AFRIEX_PROVIDER_ID = "pp_afriex_afriex"
export const AFRIEX_CHECKOUT_PROVIDER_ID = "pp_afriex-checkout_afriex"

export type AfriexMethod = "bank_transfer" | "checkout"

/** Which Afriex method a provider id is, read from its prefix as the plugin does. */
export function afriexMethodOf(providerId: string | undefined | null): AfriexMethod | undefined {
  if (providerId?.startsWith("pp_afriex-checkout_")) return "checkout"
  if (providerId?.startsWith("pp_afriex_")) return "bank_transfer"
  return undefined
}

/** The Afriex methods the store offers in a region — what the picker shows. */
export async function offeredMethods(regionId: string): Promise<AfriexMethod[]> {
  const { payment_providers } = await medusa.store.payment.listPaymentProviders({
    region_id: regionId,
  })
  const methods = payment_providers
    .map((provider) => afriexMethodOf(provider.id))
    .filter((method): method is AfriexMethod => !!method)
  // Bank transfer first, as the admin lists them.
  return [...new Set(methods)].sort((a) => (a === "bank_transfer" ? -1 : 1))
}

export const providerIdOf = (method: AfriexMethod) =>
  method === "checkout" ? AFRIEX_CHECKOUT_PROVIDER_ID : AFRIEX_PROVIDER_ID

export type StoreResponse<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; body: Record<string, any> }

/**
 * A store API call that keeps the whole answer, refusals included.
 *
 * The JS SDK throws a `FetchError` that carries only the `message` of a
 * refusal: the plugin's `code`, and the `checkout_url` and `retry_after` it
 * sends with `AFRIEX_PAYMENT_IN_PROGRESS`, are dropped. A storefront that
 * wants to act on them — send the shopper back to an open link rather than show
 * an error — has to read the body itself.
 */
export async function storeApi<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown } = {}
): Promise<StoreResponse<T>> {
  const response = await fetch(`${BACKEND_URL}${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/json",
      "x-publishable-api-key": requireEnv("MEDUSA_PUBLISHABLE_KEY"),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  })
  const json = await response.json().catch(() => ({}))
  return response.ok
    ? { ok: true, status: response.status, data: json as T }
    : { ok: false, status: response.status, body: json }
}

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.template to .env and fill it in — the ` +
        `publishable key is printed by \`pnpm seed\` in examples/medusa-backend.`
    )
  }
  return value
}
