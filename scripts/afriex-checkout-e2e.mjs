#!/usr/bin/env node
// @ts-check
/**
 * Drives Afriex Checkout through a running Medusa store's API, the way a
 * storefront would, and prints each step:
 *
 *   1. build a cart with an address and a shipping method
 *   2. choose Afriex Checkout       (select stage — nothing is sent to Afriex)
 *   3. complete the cart            (the order is placed, awaiting payment)
 *   4. ask for the payment link     (pay stage — the checkout session is created)
 *
 *   node scripts/afriex-checkout-e2e.mjs --publishable-key pk_... [--backend http://localhost:9000]
 *
 * Step 4 calls Afriex with the store's own keys. With placeholder keys it
 * fails, and the script shows the error code the storefront would get.
 *
 * No dependencies. Needs Node >= 20.
 */

const HELP = `
Afriex Checkout end-to-end run against a Medusa store

  --publishable-key <pk>   Store publishable API key (printed by the example seed).  Required.
  --backend <url>          Medusa server.                    Default: http://localhost:9000
  --email <email>          Shopper email.                    Default: shopper@example.com
  --phone <phone>          Shopper phone, local or +E.164.   Default: 08012345678
  --country <code>         Shipping and billing country.     Default: ng
  --provider <id>          Checkout provider id.             Default: pp_afriex-checkout_afriex
  --stop-after-select      Stop once the order is placed, before asking Afriex for a link.
`

/** @param {string[]} argv */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i].replace(/^--/, "")
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

const flags = parseFlags(process.argv.slice(2))
if (flags.help || typeof flags["publishable-key"] !== "string") {
  console.log(HELP)
  process.exit(flags.help ? 0 : 1)
}

const BACKEND = String(flags.backend ?? "http://localhost:9000").replace(/\/$/, "")
const KEY = String(flags["publishable-key"])
const EMAIL = String(flags.email ?? "shopper@example.com")
const PHONE = String(flags.phone ?? "08012345678")
const COUNTRY = String(flags.country ?? "ng").toLowerCase()
const PROVIDER = String(flags.provider ?? "pp_afriex-checkout_afriex")

/**
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function api(method, path, body) {
  const response = await fetch(`${BACKEND}${path}`, {
    method,
    headers: { "content-type": "application/json", "x-publishable-api-key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  return { status: response.status, json }
}

/** @param {string} label @param {{ status: number, json: any }} result */
function expectOk(label, result) {
  if (result.status >= 400) {
    console.log(`\n  ✗ ${label}: HTTP ${result.status}`)
    console.log(`    code     ${result.json.code ?? "-"}`)
    console.log(`    message  ${result.json.message ?? JSON.stringify(result.json)}\n`)
    process.exit(1)
  }
  console.log(`  ✓ ${label}`)
  return result.json
}

const address = {
  first_name: "Ada",
  last_name: "Obi",
  address_1: "12 Marina Road",
  city: "Lagos",
  postal_code: "101001",
  country_code: COUNTRY,
  phone: PHONE,
}

console.log(`\n  Afriex Checkout end to end → ${BACKEND}\n`)

const { regions } = expectOk("regions", await api("GET", "/store/regions"))
const region = regions.find((r) => r.countries?.some((c) => c.iso_2 === COUNTRY)) ?? regions[0]
if (!region) {
  console.log("  No region. Seed the store first.\n")
  process.exit(1)
}

const { payment_providers } = expectOk(
  `payment methods in ${region.name}`,
  await api("GET", `/store/payment-providers?region_id=${region.id}`)
)
console.log(`    ${payment_providers.map((p) => p.id).join(", ")}`)
if (!payment_providers.some((p) => p.id === PROVIDER)) {
  console.log(`\n  ${PROVIDER} is not turned on in ${region.name}. Turn it on in the admin (region page).\n`)
  process.exit(1)
}

const { products } = expectOk("products", await api("GET", `/store/products?region_id=${region.id}&limit=1`))
const variant = products[0]?.variants?.[0]
if (!variant) {
  console.log("  No product to buy. Seed the store first.\n")
  process.exit(1)
}

let { cart } = expectOk("cart", await api("POST", "/store/carts", { region_id: region.id, email: EMAIL }))
;({ cart } = expectOk(
  "line item",
  await api("POST", `/store/carts/${cart.id}/line-items`, { variant_id: variant.id, quantity: 1 })
))
;({ cart } = expectOk(
  "addresses",
  await api("POST", `/store/carts/${cart.id}`, { shipping_address: address, billing_address: address })
))

const { shipping_options } = expectOk(
  "shipping options",
  await api("GET", `/store/shipping-options?cart_id=${cart.id}`)
)
;({ cart } = expectOk(
  "shipping method",
  await api("POST", `/store/carts/${cart.id}/shipping-methods`, { option_id: shipping_options[0].id })
))

const { payment_collection } = expectOk(
  "payment collection",
  await api("POST", "/store/payment-collections", { cart_id: cart.id })
)

const selected = expectOk(
  "select Afriex Checkout (nothing is sent to Afriex yet)",
  await api("POST", `/store/payment-collections/${payment_collection.id}/payment-sessions`, {
    provider_id: PROVIDER,
  })
)
const selectedSession = selected.payment_collection.payment_sessions.find((s) => s.provider_id === PROVIDER)
console.log(`    session ${selectedSession.id}  stage ${selectedSession.data.stage}  charged ${selectedSession.data.chargedAmount} ${selectedSession.data.expectedCurrency}`)

const completed = expectOk("complete the cart", await api("POST", `/store/carts/${cart.id}/complete`))
if (completed.type !== "order") {
  console.log(`\n  The cart did not complete: ${JSON.stringify(completed.error ?? completed)}\n`)
  process.exit(1)
}
console.log(`    order ${completed.order.id}  #${completed.order.display_id}  awaiting payment`)

if (flags["stop-after-select"]) {
  console.log(`\n  Stopped before asking Afriex for a link. Pay-stage session id to use with the simulator is created in the next step.\n`)
  process.exit(0)
}

const paid = await api("POST", `/store/payment-collections/${payment_collection.id}/payment-sessions`, {
  provider_id: PROVIDER,
})
if (paid.status >= 400) {
  console.log(`\n  ✗ ask Afriex for the payment link: HTTP ${paid.status}`)
  console.log(`    code     ${paid.json.code ?? "-"}`)
  console.log(`    message  ${paid.json.message ?? "-"}`)
  console.log(`\n  The order is placed and waiting; the storefront would show this message and offer to try again.\n`)
  process.exit(2)
}

const session = paid.json.payment_collection.payment_sessions.find((s) => s.provider_id === PROVIDER)
console.log(`  ✓ payment link created`)
console.log(`    session  ${session.id}   (the merchantReference Afriex will echo)`)
console.log(`    link     ${session.data.checkoutUrl}`)
console.log(`    returns  ${session.data.redirectUrl}`)
console.log(`\n  Open the link to pay. Or, with the test key from "webhook:keygen", simulate the payment:`)
console.log(`    node scripts/afriex-webhook.mjs send --session ${session.id} --amount ${session.data.chargedAmount} --channel MOBILE_MONEY\n`)
