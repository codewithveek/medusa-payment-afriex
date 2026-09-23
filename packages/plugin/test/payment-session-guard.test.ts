import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"
import { afriexPaymentSessionGuard } from "../src/lib/payment-session-guard"

const BANK = "pp_afriex_afriex"
const CHECKOUT = "pp_afriex-checkout_afriex"
const COLLECTION = "paycol_01"

type Scenario = {
  collectionStatus?: string
  sessions?: { id: string; provider_id: string; data?: Record<string, unknown> }[]
  cart?: Record<string, unknown> | null
  order?: Record<string, unknown> | null
  regionProviders?: string[]
  /** What an admin saved on Settings, store-wide. */
  settings?: Record<string, unknown>
}

const ADDRESS = {
  first_name: "Ada",
  last_name: "Obi",
  phone: "08012345678",
  country_code: "ng",
}

function activeCart(overrides: Record<string, unknown> = {}) {
  return {
    id: "cart_01",
    email: "ada@example.com",
    region_id: "reg_ng",
    completed_at: null,
    billing_address: ADDRESS,
    shipping_address: ADDRESS,
    ...overrides,
  }
}

function placedOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: "order_01",
    email: "ada@example.com",
    region_id: "reg_ng",
    status: "pending",
    billing_address: ADDRESS,
    shipping_address: ADDRESS,
    ...overrides,
  }
}

function setup(scenario: Scenario, options: { lockBusy?: boolean } = {}) {
  const {
    collectionStatus = "not_paid",
    sessions = [],
    cart = activeCart(),
    order = null,
    regionProviders = [BANK, CHECKOUT],
    settings,
  } = scenario

  const query = {
    graph: vi.fn(async ({ entity }: { entity: string }) => {
      switch (entity) {
        case "payment_collection":
          return { data: [{ id: COLLECTION, status: collectionStatus, payment_sessions: sessions }] }
        case "cart_payment_collection":
          return { data: cart ? [{ cart_id: cart.id }] : [] }
        case "cart":
          return { data: cart ? [cart] : [] }
        case "order_payment_collection":
          return { data: order ? [{ order_id: order.id }] : [] }
        case "order_cart":
          return { data: order ? [{ order_id: order.id }] : [] }
        case "order":
          return { data: order ? [order] : [] }
        case "region":
          return { data: [{ id: "reg_ng", payment_providers: regionProviders.map((id) => ({ id })) }] }
        default:
          return { data: [] }
      }
    }),
  }

  const tails = new Map<string, Promise<unknown>>()
  const locking = {
    execute: vi.fn(async (key: string, job: () => Promise<unknown>) => {
      if (options.lockBusy) {
        throw new Error("Timed-out acquiring lock.")
      }
      const previous = tails.get(key) ?? Promise.resolve()
      const run = previous.catch(() => undefined).then(job)
      tails.set(key, run.catch(() => undefined))
      return run
    }),
  }

  const afriexPayments = {
    listSettings: vi.fn(async () => (settings ? [{ id: "afxcfg_1", ...settings }] : [])),
  }

  const scope = {
    resolve: (key: string) =>
      key === "query"
        ? query
        : key === "locking"
          ? locking
          : key === "afriex_payments"
            ? afriexPayments
            : undefined,
  }

  return { query, locking, scope }
}

function request(
  scope: unknown,
  body: Record<string, unknown>,
  { admin = false }: { admin?: boolean } = {}
) {
  const req: any = { scope, params: { id: COLLECTION }, body: { ...body } }
  if (admin) {
    req.validatedBody = { ...body }
  }
  return req
}

function response() {
  const res: any = new EventEmitter()
  res.headersSent = false
  res.statusCode = 200
  res.status = vi.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = vi.fn((body: unknown) => {
    res.body = body
    res.headersSent = true
    res.emit("finish")
    return res
  })
  return res
}

/** Stands in for Medusa's handler: answers a moment later, as a real one would. */
function handler(res: any) {
  return vi.fn(() => {
    setTimeout(() => res.json({ ok: true }), 5)
  })
}

async function run(scenario: Scenario, body: Record<string, unknown>, options: { admin?: boolean; lockBusy?: boolean } = {}) {
  const { scope, locking, query } = setup(scenario, options)
  const req = request(scope, body, options)
  const res = response()
  const next = handler(res)
  await afriexPaymentSessionGuard(req, res, next)
  return { req, res, next, locking, query }
}

describe("replacing a session while money may still be moving", () => {
  const openLink = {
    id: "payses_open",
    provider_id: CHECKOUT,
    data: {
      stage: "open",
      checkoutUrl: "https://pay.afriex.com/pay/abc",
      currentStatus: "PENDING",
      expiresAtEstimate: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    },
  }

  it("refuses to replace an open checkout link, whichever provider is asked for", async () => {
    for (const provider_id of [BANK, CHECKOUT, "pp_system_default", "pp_stripe_stripe"]) {
      const { res, next } = await run({ sessions: [openLink] }, { provider_id })

      expect(next).not.toHaveBeenCalled()
      expect(res.statusCode).toBe(409)
      expect(res.body).toMatchObject({
        code: "AFRIEX_PAYMENT_IN_PROGRESS",
        checkout_url: "https://pay.afriex.com/pay/abc",
        retry_after: expect.any(String),
      })
    }
  })

  it("refuses on the admin route too", async () => {
    const { res } = await run({ sessions: [openLink] }, { provider_id: "pp_system_default" }, { admin: true })
    expect(res.statusCode).toBe(409)
  })

  it("lets a failed or expired link be replaced", async () => {
    const failed = { ...openLink, data: { ...openLink.data, currentStatus: "FAILED" } }
    const expired = {
      ...openLink,
      data: { ...openLink.data, expiresAtEstimate: new Date(Date.now() - 1000).toISOString() },
    }

    for (const session of [failed, expired]) {
      const { next } = await run({ sessions: [session] }, { provider_id: BANK })
      expect(next).toHaveBeenCalled()
    }
  })

  it("refuses while Afriex is still reporting progress on a transaction", async () => {
    const moving = {
      id: "payses_bank",
      provider_id: BANK,
      data: {
        currentStatus: "PROCESSING",
        afriexTransactionId: "txn_1",
        lastEventAt: new Date(Date.now() - 60 * 1000).toISOString(),
      },
    }

    const { res } = await run({ sessions: [moving] }, { provider_id: CHECKOUT })
    expect(res.body).toMatchObject({ code: "AFRIEX_PAYMENT_IN_PROGRESS" })

    const stale = { ...moving, data: { ...moving.data, lastEventAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() } }
    const later = await run({ sessions: [stale] }, { provider_id: CHECKOUT })
    expect(later.next).toHaveBeenCalled()
  })

  it("refuses once money has been recorded on a session", async () => {
    for (const currentStatus of ["SUCCESS", "AMOUNT_MISMATCH", "SETTLED_AFTER_CANCEL", "COLLECTION_AMOUNT_CHANGED"]) {
      const { res } = await run(
        { sessions: [{ id: "payses_paid", provider_id: BANK, data: { currentStatus } }] },
        { provider_id: "pp_system_default" }
      )
      expect(res.statusCode).toBe(409)
    }
  })

  it("stays out of the way when the collection holds no Afriex session", async () => {
    const { next, req } = await run(
      { sessions: [{ id: "payses_s", provider_id: "pp_stripe_stripe", data: {} }] },
      { provider_id: "pp_stripe_stripe", data: { anything: 1 } }
    )
    expect(next).toHaveBeenCalled()
    expect(req.body.data).toEqual({ anything: 1 })
  })
})

describe("paying an order that already exists", () => {
  const completed = { cart: activeCart({ completed_at: "2026-09-22T10:00:00Z" }), order: placedOrder() }

  it("refuses a cancelled order", async () => {
    const { res } = await run(
      { ...completed, order: placedOrder({ status: "canceled" }), collectionStatus: "canceled" },
      { provider_id: CHECKOUT }
    )
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ code: "AFRIEX_ORDER_NOT_PAYABLE" })
  })

  it("refuses an order that is already paid", async () => {
    const { res } = await run({ ...completed, collectionStatus: "completed" }, { provider_id: BANK })
    expect(res.body).toMatchObject({ code: "AFRIEX_ORDER_NOT_PAYABLE" })
  })

  it("refuses a method the admin turned off in the order's region, which Medusa no longer checks", async () => {
    const { res } = await run({ ...completed, regionProviders: [BANK] }, { provider_id: CHECKOUT })
    expect(res.statusCode).toBe(400)
    expect(res.body).toMatchObject({ code: "AFRIEX_METHOD_UNAVAILABLE" })
  })

  it("re-checks the region for collections with no cart as well", async () => {
    const { res } = await run(
      { cart: null, order: placedOrder(), regionProviders: [CHECKOUT] },
      { provider_id: BANK }
    )
    expect(res.body).toMatchObject({ code: "AFRIEX_METHOD_UNAVAILABLE" })
  })
})

describe("building a checkout session on the server", () => {
  it("makes it a selection while the cart is open, with the customer from the cart", async () => {
    const { req, next } = await run(
      {},
      {
        provider_id: CHECKOUT,
        data: {
          return_url: "https://shop.example.com/back",
          afriex: { stage: "pay", customer: { name: "Mallory" } },
          currentStatus: "SUCCESS",
        },
      }
    )

    expect(next).toHaveBeenCalled()
    expect(req.body.data).toEqual({
      return_url: "https://shop.example.com/back",
      afriex: {
        stage: "select",
        customer: { name: "Ada Obi", email: "ada@example.com", phone: "+2348012345678", countryCode: "NG" },
        channels: null,
        hide_bank: false,
        order_id: null,
        cart_id: "cart_01",
        payment_collection_id: COLLECTION,
      },
    })
  })

  it("makes it a payment once the order exists, and writes what the admin route reads", async () => {
    const { req } = await run(
      { cart: activeCart({ completed_at: "2026-09-22T10:00:00Z" }), order: placedOrder() },
      { provider_id: CHECKOUT },
      { admin: true }
    )

    expect(req.validatedBody.data.afriex).toMatchObject({ stage: "pay", order_id: "order_01" })
    expect(req.body.data.afriex).toMatchObject({ stage: "pay" })
  })

  it("asks for what is missing before any order is placed", async () => {
    const noPhone = await run(
      { cart: activeCart({ billing_address: { country_code: "ng" }, shipping_address: null }) },
      { provider_id: CHECKOUT }
    )
    expect(noPhone.res.body).toMatchObject({ code: "AFRIEX_CHECKOUT_PHONE_REQUIRED" })
    expect(noPhone.next).not.toHaveBeenCalled()

    const noEmail = await run({ cart: activeCart({ email: null }) }, { provider_id: CHECKOUT })
    expect(noEmail.res.body).toMatchObject({ code: "AFRIEX_CHECKOUT_EMAIL_REQUIRED" })
  })

  it("leaves bank transfer's data alone", async () => {
    const { req } = await run({}, { provider_id: BANK, data: { note: "x" } })
    expect(req.body.data).toEqual({ note: "x" })
  })
})

describe("the collection lock", () => {
  it("is held until the response is sent, so a second request sees what the first did", async () => {
    const { scope, locking } = setup({})
    const firstRes = response()
    let firstAnswered = false
    const firstNext = vi.fn(() => {
      setTimeout(() => {
        firstAnswered = true
        firstRes.json({ ok: true })
      }, 20)
    })
    let secondStartedAfterFirst: boolean | undefined
    const secondRes = response()
    const secondNext = vi.fn(() => {
      secondStartedAfterFirst = firstAnswered
      secondRes.json({ ok: true })
    })

    await Promise.all([
      afriexPaymentSessionGuard(request(scope, { provider_id: CHECKOUT }), firstRes, firstNext),
      afriexPaymentSessionGuard(request(scope, { provider_id: CHECKOUT }), secondRes, secondNext),
    ])

    expect(locking.execute).toHaveBeenCalledWith(
      "afriex:payment-collection:paycol_01",
      expect.any(Function),
      expect.objectContaining({ timeout: expect.any(Number) })
    )
    expect(secondStartedAfterFirst).toBe(true)
  })

  it("answers 409 when another request or a webhook holds it too long", async () => {
    const { res, next } = await run({}, { provider_id: CHECKOUT }, { lockBusy: true })
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(409)
    expect(res.body).toMatchObject({ code: "AFRIEX_PAYMENT_IN_PROGRESS" })
  })

  it("hands a lookup failure to Medusa's error handling instead of answering itself", async () => {
    const { scope, query } = setup({})
    query.graph.mockRejectedValueOnce(new Error("database unavailable"))
    const res = response()
    const next = vi.fn()

    await afriexPaymentSessionGuard(request(scope, { provider_id: CHECKOUT }), res, next)

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: "database unavailable" }))
    expect(res.json).not.toHaveBeenCalled()
  })
})

describe("what the admin decided, store-wide", () => {
  it("passes the admin's channel choice to the provider", async () => {
    const { req } = await run(
      { settings: { checkout_channels: ["MOBILE_MONEY"] } },
      { provider_id: CHECKOUT }
    )

    expect(req.body.data.afriex).toMatchObject({ channels: ["MOBILE_MONEY"] })
  })

  it("asks to hide checkout's bank option only where the store's own bank transfer is on", async () => {
    const settings = { hide_bank_channel_where_bank_transfer: true }

    const withBank = await run({ settings }, { provider_id: CHECKOUT })
    expect(withBank.req.body.data.afriex).toMatchObject({ hide_bank: true })

    const without = await run(
      { settings, regionProviders: [CHECKOUT] },
      { provider_id: CHECKOUT }
    )
    expect(without.req.body.data.afriex).toMatchObject({ hide_bank: false })
  })

  it("carries on with the defaults when the settings cannot be read", async () => {
    const { req, next } = await run({}, { provider_id: CHECKOUT })

    expect(next).toHaveBeenCalled()
    expect(req.body.data.afriex).toMatchObject({ channels: null, hide_bank: false })
  })
})
