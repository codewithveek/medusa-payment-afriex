import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"

const updateRegions = vi.hoisted(() => vi.fn(async (_args: any) => ({ result: [] as unknown[] })))

vi.mock("@medusajs/medusa/core-flows", () => ({
  updateRegionsWorkflow: vi.fn(() => ({ run: updateRegions })),
}))

import { getAfriexOverview } from "../src/lib/overview"
import { setMethodEverywhere } from "../src/lib/method-everywhere"
import { getOrderPayment } from "../src/lib/order-payment"
import { AfriexAdminError } from "../src/lib/admin-error"
import { createPaymentsStore } from "./mocks/afriex.mock"

const BANK = "pp_afriex_afriex"
const CHECKOUT = "pp_afriex-checkout_afriex"

type Session = {
  id: string
  provider_id: string
  status: string
  payment_collection_id?: string
  amount?: string
  currency_code?: string
  data?: Record<string, unknown>
}

const soon = () => new Date(Date.now() + 10 * 60 * 1000).toISOString()
const past = () => new Date(Date.now() - 10 * 60 * 1000).toISOString()

function setup(options: {
  regions?: { id: string; name: string; currency_code: string; providers: string[] }[]
  registered?: string[]
  sessions?: Session[]
  config?: unknown
  webhooks?: { event_id: string; processed_at: string }[]
} = {}) {
  const {
    regions = [
      { id: "reg_ng", name: "Nigeria", currency_code: "ngn", providers: [BANK, CHECKOUT] },
      { id: "reg_gh", name: "Ghana", currency_code: "ghs", providers: [CHECKOUT, "pp_stripe_stripe"] },
    ],
    registered = [BANK, CHECKOUT, "pp_stripe_stripe"],
    sessions = [],
    config,
    webhooks = [],
  } = options

  const state = regions.map((region) => ({ ...region }))
  updateRegions.mockImplementation(async ({ input }: any) => {
    const region = state.find((r) => r.id === input.selector.id)
    if (region) {
      region.providers = input.update.payment_providers
    }
    return { result: [] }
  })

  const payments = createPaymentsStore()

  const query = {
    graph: vi.fn(async ({ entity, filters }: any) => {
      switch (entity) {
        case "region":
          return {
            data: state.map((region) => ({
              id: region.id,
              name: region.name,
              currency_code: region.currency_code,
              payment_providers: region.providers.map((id) => ({ id })),
            })),
          }
        case "order_payment_collection":
          return {
            data: [{ order_id: "order_01", payment_collection_id: "paycol_01" }].filter((link) =>
              filters?.order_id
                ? link.order_id === filters.order_id
                : [filters?.payment_collection_id ?? []].flat().includes(link.payment_collection_id)
            ),
          }
        case "order":
          return { data: [{ id: "order_01", display_id: 42 }] }
        default:
          return { data: [] }
      }
    }),
  }

  const paymentModule = {
    listPaymentProviders: vi.fn(async () => registered.map((id) => ({ id }))),
    listPaymentSessions: vi.fn(async (filters: any) => {
      if (filters.provider_id) {
        return sessions.filter((session) => session.provider_id === filters.provider_id)
      }
      if (filters.id) {
        return sessions.filter((session) => [filters.id].flat().includes(session.id))
      }
      if (filters.payment_collection_id) {
        return sessions.filter((session) =>
          [filters.payment_collection_id].flat().includes(session.payment_collection_id)
        )
      }
      return sessions
    }),
  }

  const registry: Record<string, unknown> = {
    query,
    payment: paymentModule,
    afriex_payments: payments,
    afriex_webhook: {
      listProcessedWebhooks: vi.fn(async () => webhooks),
    },
    configModule: config,
  }

  const container = {
    resolve: (key: string) => {
      if (key in registry) {
        return registry[key]
      }
      throw new Error(`nothing registered for ${key}`)
    },
  } as unknown as MedusaContainer

  return { container, payments, state, query }
}

beforeEach(() => {
  updateRegions.mockClear()
})

describe("the Afriex overview", () => {
  it("says which methods are on where, and what is still waiting", async () => {
    const { container } = setup({
      sessions: [
        { id: "s1", provider_id: BANK, status: "pending", payment_collection_id: "paycol_01" },
        { id: "s2", provider_id: BANK, status: "authorized" },
        {
          id: "s3",
          provider_id: CHECKOUT,
          status: "pending",
          data: { stage: "open", expiresAtEstimate: soon() },
        },
        { id: "s4", provider_id: CHECKOUT, status: "pending", data: { stage: "selected" } },
        {
          id: "s5",
          provider_id: CHECKOUT,
          status: "pending",
          data: { stage: "open", expiresAtEstimate: past() },
        },
      ],
    })

    const overview = await getAfriexOverview(container)

    expect(overview.regions).toEqual([
      expect.objectContaining({ id: "reg_ng", name: "Nigeria", currency_code: "ngn", methods: [BANK, CHECKOUT] }),
      expect.objectContaining({ id: "reg_gh", name: "Ghana", currency_code: "ghs", methods: [CHECKOUT] }),
    ])
    // Nigeria collects both ways; Ghana, per Afriex's coverage, neither yet.
    expect(overview.regions[0]!.availability).toEqual({
      [BANK]: { available: true, reason: null },
      [CHECKOUT]: { available: true, reason: null },
    })
    expect(overview.regions[1]!.availability[CHECKOUT]).toMatchObject({
      available: false,
      reason: expect.stringMatching(/GHS.*coming soon/),
    })
    expect(overview.methods).toEqual([
      expect.objectContaining({
        method: "bank_transfer",
        regions_on: ["reg_ng"],
        waiting: 1,
        waiting_without_link: 0,
      }),
      expect.objectContaining({
        method: "checkout",
        regions_on: ["reg_ng", "reg_gh"],
        waiting: 1,
        waiting_without_link: 1,
      }),
    ])
  })

  it("lists what needs a person, with the order it belongs to", async () => {
    const { container, payments } = setup({
      sessions: [
        {
          id: "s_held",
          provider_id: BANK,
          status: "requires_more",
          payment_collection_id: "paycol_01",
          data: {
            currentStatus: "AMOUNT_MISMATCH",
            expectedAmount: "25000",
            receivedAmount: "20000",
            expectedCurrency: "NGN",
          },
        },
        { id: "s_fine", provider_id: BANK, status: "captured", data: { currentStatus: "SUCCESS" } },
      ],
    })
    await payments.createPaymentReferences({
      reference: "payses_OLD",
      method: "bank_transfer",
      payment_session_id: "payses_OLD",
      payment_collection_id: "paycol_01",
      amount: "25000",
      currency_code: "NGN",
      late_payments: [
        { transaction_id: "txn_late", amount: "8000", currency: "NGN", received_at: "x", status: "held" },
        { transaction_id: "txn_done", amount: "1000", currency: "NGN", received_at: "x", status: "applied" },
      ],
    })

    const overview = await getAfriexOverview(container)

    expect(overview.attention).toEqual([
      expect.objectContaining({
        kind: "session",
        payment_session_id: "s_held",
        status: "AMOUNT_MISMATCH",
        expected: "25000",
        received: "20000",
        order_id: "order_01",
        display_id: 42,
      }),
      expect.objectContaining({
        kind: "late_payment",
        reference: "payses_OLD",
        transaction_id: "txn_late",
        amount: "8000",
        order_id: "order_01",
        display_id: 42,
      }),
    ])
  })

  it("warns about what a shopper would hit, and reads the return URL from the config", async () => {
    const { container } = setup({
      regions: [{ id: "reg_ng", name: "Nigeria", currency_code: "ngn", providers: [BANK] }],
      config: {
        modules: [
          {
            options: {
              providers: [
                {
                  resolve: "medusa-payment-afriex/providers/afriex-payment",
                  options: { checkout: { returnUrl: "https://shop.example.com/back/{order_id}" } },
                },
              ],
            },
          },
        ],
      },
    })

    const overview = await getAfriexOverview(container)
    const byId = Object.fromEntries(overview.setup.map((check) => [check.id, check]))

    expect(byId["checkout:regions"]).toMatchObject({ level: "warn" })
    expect(byId["checkout:regions"]?.message).toMatch(/not on in any region/)
    expect(byId["bank_transfer:regions"]).toMatchObject({ level: "ok" })
    expect(byId["checkout:return_url"]).toMatchObject({ level: "ok" })
    expect(byId["checkout:return_url"]?.message).toMatch(/shop\.example\.com/)
    expect(byId["webhook:seen"]).toMatchObject({ level: "warn" })
    expect(byId["locking"]).toMatchObject({ level: "advice" })
  })

  it("warns where a method is on but Afriex cannot collect the currency", async () => {
    // The default store has Afriex Checkout on in Ghana.
    const checks = (await getAfriexOverview(setup().container)).setup

    const warning = checks.find((check) => check.id === "checkout:cannot_collect:reg_gh")
    expect(warning).toMatchObject({ level: "warn" })
    expect(warning?.message).toMatch(/Afriex Checkout is on in Ghana \(GHS\), but Afriex cannot collect GHS yet/)
    expect(checks.find((check) => check.id === "bank_transfer:cannot_collect:reg_ng")).toBeUndefined()
    expect(checks.find((check) => check.id === "bank_transfer:approval")).toMatchObject({ level: "advice" })
  })

  it("trusts the store's own currency list over Afriex's page", async () => {
    const { container } = setup({
      config: {
        modules: [
          {
            options: {
              providers: [
                {
                  resolve: "medusa-payment-afriex/providers/afriex-payment",
                  options: {
                    checkout: {
                      returnUrl: "https://shop.example.com/back/{order_id}",
                      currencyChannels: { GHS: ["MOBILE_MONEY"] },
                    },
                  },
                },
              ],
            },
          },
        ],
      },
    })

    const overview = await getAfriexOverview(container)

    expect(overview.regions[1]!.availability[CHECKOUT]).toEqual({ available: true, reason: null })
    expect(overview.setup.find((check) => check.id === "checkout:cannot_collect:reg_gh")).toBeUndefined()
  })

  it("says so when checkout has no return URL, and when it cannot tell", async () => {
    const withoutUrl = setup({
      config: { modules: [{ options: { providers: [{ resolve: "medusa-payment-afriex/providers/afriex-payment", options: {} }] } }] },
    })
    const checks = (await getAfriexOverview(withoutUrl.container)).setup
    expect(checks.find((check) => check.id === "checkout:return_url")).toMatchObject({
      level: "warn",
    })

    // No config to read: the page claims nothing rather than guessing.
    const unknown = setup()
    const quiet = (await getAfriexOverview(unknown.container)).setup
    expect(quiet.find((check) => check.id === "checkout:return_url")).toMatchObject({ level: "ok" })
  })

  it("still answers for a store that has not run the migrations", async () => {
    const { container } = setup()
    const overview = await getAfriexOverview(container)

    expect(overview.last_webhook).toBeNull()
    expect(overview.attention).toEqual([])
    expect(overview.settings.checkoutChannels).toBeNull()
  })
})

describe("turning a method off everywhere", () => {
  it("removes it from every region and remembers where it was", async () => {
    const { container, state, payments } = setup()

    const result = await setMethodEverywhere(container, { method: "checkout", enabled: false })

    expect(result.changed_regions).toEqual(["reg_ng", "reg_gh"])
    expect(state.map((region) => region.providers)).toEqual([[BANK], ["pp_stripe_stripe"]])
    expect([...payments.settings.values()][0]).toMatchObject({
      paused_regions: { checkout: ["reg_ng", "reg_gh"] },
    })
  })

  it("puts it back in exactly those regions, not everywhere", async () => {
    const { container, state } = setup({
      regions: [
        { id: "reg_ng", name: "Nigeria", currency_code: "ngn", providers: [BANK, CHECKOUT] },
        { id: "reg_gh", name: "Ghana", currency_code: "ghs", providers: [BANK] },
      ],
    })

    await setMethodEverywhere(container, { method: "checkout", enabled: false })
    await setMethodEverywhere(container, { method: "checkout", enabled: true })

    expect(state.map((region) => region.providers)).toEqual([[BANK, CHECKOUT], [BANK]])
  })

  it("asks before leaving a region with no payment method at all", async () => {
    const { container, state } = setup({
      regions: [{ id: "reg_ng", name: "Nigeria", currency_code: "ngn", providers: [CHECKOUT] }],
    })

    await expect(
      setMethodEverywhere(container, { method: "checkout", enabled: false })
    ).rejects.toMatchObject({ code: "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS" })
    expect(state[0]?.providers).toEqual([CHECKOUT])

    await setMethodEverywhere(container, { method: "checkout", enabled: false, confirmEmpty: true })
    expect(state[0]?.providers).toEqual([])
  })

  it("refuses a method that is not Afriex's, or one not registered", async () => {
    const { container } = setup()
    await expect(
      setMethodEverywhere(container, { method: "card", enabled: false })
    ).rejects.toBeInstanceOf(AfriexAdminError)

    const { container: bare } = setup({ registered: ["pp_stripe_stripe"] })
    await expect(
      setMethodEverywhere(bare, { method: "checkout", enabled: false })
    ).rejects.toMatchObject({ code: "AFRIEX_PROVIDER_NOT_REGISTERED" })
  })
})

describe("what an order's widget reads", () => {
  it("returns the order's Afriex sessions and the references behind them", async () => {
    const { container, payments } = setup({
      sessions: [
        {
          id: "payses_now",
          provider_id: CHECKOUT,
          status: "pending",
          payment_collection_id: "paycol_01",
          amount: "25000",
          currency_code: "ngn",
          data: { stage: "open" },
        },
        { id: "payses_other", provider_id: "pp_stripe_stripe", status: "pending", payment_collection_id: "paycol_01" },
      ],
    })
    await payments.createPaymentReferences({
      reference: "payses_OLD",
      method: "checkout",
      payment_session_id: "payses_OLD",
      payment_collection_id: "paycol_01",
      amount: "25000",
      currency_code: "NGN",
      late_payments: [
        { transaction_id: "txn_late", amount: "25000", currency: "NGN", received_at: "x", status: "held" },
      ],
    })

    const payment = await getOrderPayment(container, "order_01")

    expect(payment.sessions).toEqual([
      expect.objectContaining({ id: "payses_now", method: "checkout", status: "pending" }),
    ])
    expect(payment.references).toEqual([
      expect.objectContaining({
        reference: "payses_OLD",
        late_payments: [expect.objectContaining({ transaction_id: "txn_late", status: "held" })],
      }),
    ])
  })

  it("answers empty for an order with no payment collection", async () => {
    const { container } = setup()
    expect(await getOrderPayment(container, "order_nope")).toEqual({
      order_id: "order_nope",
      sessions: [],
      references: [],
    })
  })
})
