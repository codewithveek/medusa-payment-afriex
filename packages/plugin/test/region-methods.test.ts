import { beforeEach, describe, expect, it, vi } from "vitest"

const updateRegions = vi.hoisted(() => vi.fn(async (_args: any) => ({ result: [] as unknown[] })))

vi.mock("@medusajs/medusa/core-flows", () => ({
  updateRegionsWorkflow: vi.fn(() => ({ run: updateRegions })),
}))

import { AfriexAdminError } from "../src/lib/admin-error"
import { getRegionMethods, setRegionMethod } from "../src/lib/region-methods"

const BANK = "pp_afriex_afriex"
const CHECKOUT = "pp_afriex-checkout_afriex"

const FUTURE = new Date(Date.now() + 10 * 60 * 1000).toISOString()
const PAST = new Date(Date.now() - 10 * 60 * 1000).toISOString()

// Collections col_ng_* belong to carts or orders in reg_ng; col_gh_* to one in reg_gh.
const SESSIONS: Record<string, { id: string; status: string; payment_collection_id: string; data?: object }[]> = {
  [BANK]: [
    { id: "s1", status: "pending_authorization", payment_collection_id: "col_ng_order" },
    { id: "s2", status: "authorized", payment_collection_id: "col_ng_order_2" },
    { id: "s3", status: "pending", payment_collection_id: "col_ng_cart" },
    { id: "s4", status: "pending", payment_collection_id: "col_gh_cart" },
  ],
  [CHECKOUT]: [
    // Chosen, never opened: no link, so no money can come through it.
    { id: "c1", status: "pending_authorization", payment_collection_id: "col_ng_order", data: { stage: "selected" } },
    { id: "c2", status: "pending", payment_collection_id: "col_ng_order", data: { stage: "open", expiresAtEstimate: FUTURE } },
    { id: "c3", status: "pending", payment_collection_id: "col_ng_order", data: { stage: "open", expiresAtEstimate: PAST } },
    // Expired link, but a transfer through it is still moving.
    {
      id: "c4",
      status: "pending",
      payment_collection_id: "col_ng_edit",
      data: { stage: "open", expiresAtEstimate: PAST, afriexTransactionId: "txn_1", currentStatus: "PROCESSING" },
    },
    { id: "c5", status: "pending", payment_collection_id: "col_ng_order", data: { stage: "open", expiresAtEstimate: PAST, afriexTransactionId: "txn_2", currentStatus: "FAILED" } },
    { id: "c6", status: "pending", payment_collection_id: "col_gh_cart", data: { stage: "open", expiresAtEstimate: FUTURE } },
  ],
}

const LINKS: Record<string, { payment_collection_id: string; cart_id?: string; order_id?: string }[]> = {
  cart_payment_collection: [
    { cart_id: "cart_ng", payment_collection_id: "col_ng_cart" },
    { cart_id: "cart_ng_done", payment_collection_id: "col_ng_order" },
    { cart_id: "cart_gh", payment_collection_id: "col_gh_cart" },
  ],
  order_payment_collection: [
    { order_id: "order_ng", payment_collection_id: "col_ng_order" },
    { order_id: "order_ng", payment_collection_id: "col_ng_edit" },
  ],
}

const OWNERS: Record<string, { id: string; region_id: string }[]> = {
  cart: [
    { id: "cart_ng", region_id: "reg_ng" },
    { id: "cart_ng_done", region_id: "reg_ng" },
    { id: "cart_gh", region_id: "reg_gh" },
  ],
  order: [{ id: "order_ng", region_id: "reg_ng" }],
}

const within = (value: string, filter: string | string[]) =>
  Array.isArray(filter) ? filter.includes(value) : filter === value

function container(
  linked: string[],
  registered = ["pp_system_default", "pp_stripe_stripe", BANK, CHECKOUT],
  regionId = "reg_ng"
) {
  const region = { id: regionId, payment_providers: linked.map((id) => ({ id })) }

  updateRegions.mockImplementation(async ({ input }: any) => {
    region.payment_providers = input.update.payment_providers.map((id: string) => ({ id }))
    return { result: [] }
  })

  const registry: Record<string, unknown> = {
    query: {
      graph: vi.fn(async ({ entity, filters }: any) => {
        if (entity === "region") {
          return { data: filters.id === region.id ? [region] : [] }
        }
        if (entity in LINKS) {
          return { data: (LINKS[entity] ?? []).filter((link) => within(link.payment_collection_id, filters.payment_collection_id)) }
        }
        return { data: (OWNERS[entity] ?? []).filter((owner) => within(owner.id, filters.id)) }
      }),
    },
    payment: {
      listPaymentProviders: vi.fn(async (filters: { id?: string } = {}) =>
        registered.filter((id) => !filters.id || id === filters.id).map((id) => ({ id }))
      ),
      listPaymentSessions: vi.fn(async ({ provider_id }: { provider_id: string }) => SESSIONS[provider_id] ?? []),
    },
  }

  return { resolve: (key: string) => registry[key], region } as any
}

async function refusedWith(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AfriexAdminError)
  await promise.catch((error: AfriexAdminError) => expect(error.code).toBe(code))
}

beforeEach(() => {
  updateRegions.mockClear()
})

describe("Afriex payment methods per region", () => {
  it("lists each Afriex method, whether it is on here, and what is still waiting on it", async () => {
    const result = await getRegionMethods(container([BANK, "pp_stripe_stripe"]), "reg_ng")

    // Bank: s1 and s3. Not s2 (paid) or s4 (another region).
    // Checkout: c2 (open link) and c4 (transfer moving). Not c1 (never opened),
    // c3 (link expired), c5 (failed) or c6 (another region).
    expect(result).toEqual({
      region_id: "reg_ng",
      methods: [
        { provider_id: BANK, method: "bank_transfer", enabled: true, waiting: 2 },
        { provider_id: CHECKOUT, method: "checkout", enabled: false, waiting: 2 },
      ],
    })
  })

  it("counts nothing waiting in a region no payment belongs to", async () => {
    const result = await getRegionMethods(container([BANK], undefined, "reg_empty"), "reg_empty")

    expect(result.methods.map((m) => m.waiting)).toEqual([0, 0])
  })

  it("turns one method off and keeps every other provider on the region", async () => {
    const scope = container([BANK, CHECKOUT, "pp_stripe_stripe"])

    const result = await setRegionMethod(scope, { regionId: "reg_ng", providerId: CHECKOUT, enabled: false })

    expect(updateRegions).toHaveBeenCalledWith({
      input: { selector: { id: "reg_ng" }, update: { payment_providers: [BANK, "pp_stripe_stripe"] } },
    })
    expect(result.methods.find((m) => m.method === "checkout")?.enabled).toBe(false)
  })

  it("turns one method on", async () => {
    const scope = container(["pp_stripe_stripe"])

    await setRegionMethod(scope, { regionId: "reg_ng", providerId: CHECKOUT, enabled: true })

    expect(updateRegions).toHaveBeenCalledWith({
      input: { selector: { id: "reg_ng" }, update: { payment_providers: ["pp_stripe_stripe", CHECKOUT] } },
    })
  })

  it("does nothing when the method is already as asked", async () => {
    await setRegionMethod(container([BANK]), { regionId: "reg_ng", providerId: BANK, enabled: true })
    expect(updateRegions).not.toHaveBeenCalled()
  })

  it("asks before leaving a region with no payment method at all", async () => {
    const scope = container([BANK])

    await refusedWith(
      setRegionMethod(scope, { regionId: "reg_ng", providerId: BANK, enabled: false }),
      "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS"
    )
    expect(updateRegions).not.toHaveBeenCalled()

    await setRegionMethod(scope, { regionId: "reg_ng", providerId: BANK, enabled: false, confirmEmpty: true })
    expect(updateRegions).toHaveBeenCalledWith({
      input: { selector: { id: "reg_ng" }, update: { payment_providers: [] } },
    })
  })

  it("only touches Afriex providers that are registered, in regions that exist", async () => {
    await refusedWith(
      setRegionMethod(container([]), { regionId: "reg_ng", providerId: "pp_stripe_stripe", enabled: false }),
      "AFRIEX_NOT_AN_AFRIEX_PROVIDER"
    )
    await refusedWith(
      setRegionMethod(container([], ["pp_stripe_stripe", BANK]), {
        regionId: "reg_ng",
        providerId: CHECKOUT,
        enabled: true,
      }),
      "AFRIEX_PROVIDER_NOT_REGISTERED"
    )
    await refusedWith(
      setRegionMethod(container([]), { regionId: "reg_nope", providerId: BANK, enabled: true }),
      "AFRIEX_REGION_NOT_FOUND"
    )
  })
})
