import { generateKeyPairSync } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError, ValidationError } from "@afriex/sdk"

const sdk = vi.hoisted(() => ({
  customers: { create: vi.fn(), delete: vi.fn() },
  paymentMethods: { createVirtualAccount: vi.fn(), get: vi.fn(), delete: vi.fn() },
  checkout: { createSession: vi.fn() },
  webhooks: { verifyAndParse: vi.fn() },
}))

vi.mock("../src/lib/afriex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/afriex")>()),
  createAfriexSdk: () => sdk,
}))

import AfriexCheckoutService from "../src/providers/afriex-payment/checkout-service"
import * as provider from "../src/providers/afriex-payment"

const PUBLIC_KEY = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
  type: "spki",
  format: "pem",
}) as string

const SESSION_ID = "payses_01CHECKOUT"

const OPTIONS = {
  apiKey: "sk_test",
  environment: "staging" as const,
  webhookPublicKey: PUBLIC_KEY,
  checkout: { returnUrl: "https://shop.example.com/checkout/afriex/return/{order_id}" },
}

const CUSTOMER = {
  name: "Ada Obi",
  email: "ada@example.com",
  phone: "+2348012345678",
  countryCode: "NG",
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const eventBus = { emit: vi.fn(async () => undefined) }

function buildService(options: Record<string, unknown> = {}) {
  return new (AfriexCheckoutService as any)(
    { logger, event_bus: eventBus },
    { ...OPTIONS, ...options }
  )
}

function input(afriex?: Record<string, unknown>, extra: Record<string, unknown> = {}, amount: unknown = 25000) {
  return {
    amount,
    currency_code: "ngn",
    data: { session_id: SESSION_ID, ...(afriex ? { afriex } : {}), ...extra },
    context: {},
  } as any
}

const PAY = {
  stage: "pay",
  customer: CUSTOMER,
  order_id: "order_01",
  cart_id: "cart_01",
  payment_collection_id: "paycol_01",
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise
  } catch (error) {
    return error as { code?: string; type?: string; message: string }
  }
  throw new Error("expected a refusal")
}

beforeEach(() => {
  vi.clearAllMocks()
  sdk.checkout.createSession.mockResolvedValue({
    checkoutUrl: "https://pay.afriex.com/pay/abc",
    channels: ["VIRTUAL_BANK_ACCOUNT"],
  })
})

describe("the checkout provider", () => {
  it("is registered next to bank transfer under its own identifier", () => {
    expect(AfriexCheckoutService.identifier).toBe("afriex-checkout")
    expect(provider.AfriexCheckoutService).toBe(AfriexCheckoutService)
  })

  describe("select stage", () => {
    it("makes no call to Afriex and lets the order be placed", async () => {
      const service = buildService()

      const result = await service.initiatePayment(input({ stage: "select", customer: CUSTOMER }))

      expect(sdk.checkout.createSession).not.toHaveBeenCalled()
      expect(result.status).toBe("pending")
      expect(result.data).toMatchObject({
        method: "checkout",
        stage: "selected",
        expectedAmountMinor: "2500000",
        chargedAmount: "25000",
        checkoutUrl: null,
      })
      await expect(service.authorizePayment({ data: result.data })).resolves.toMatchObject({
        status: "pending_authorization",
      })
    })

    it("treats missing or malformed instructions as a selection", async () => {
      const service = buildService()

      for (const afriex of [undefined, "pay", { stage: "pay" }, { stage: "pay", customer: { name: 1 } }]) {
        const result = await service.initiatePayment(input(afriex as any))
        expect(result.data).toMatchObject({ stage: "selected" })
      }
      expect(sdk.checkout.createSession).not.toHaveBeenCalled()
    })

    it("clears every key it later trusts, whatever was sent or replayed", async () => {
      const service = buildService()

      const result = await service.initiatePayment(
        input(undefined, {
          currentStatus: "SUCCESS",
          afriexTransactionId: "txn_fake",
          receivedAmount: "25000",
          extraDeposits: [{ transactionId: "x" }],
          checkoutUrl: "https://pay.afriex.com/pay/stale",
          merchantReference: "payses_OLD",
          stage: "open",
        })
      )

      expect(result.data).toMatchObject({
        currentStatus: "PENDING",
        afriexTransactionId: null,
        receivedAmount: null,
        extraDeposits: [],
        checkoutUrl: null,
        merchantReference: null,
        stage: "selected",
        afriex: null,
        return_url: null,
      })
    })
  })

  describe("refusals before any order exists", () => {
    it("refuses when checkout is not set up", async () => {
      const error = await refusal(buildService({ checkout: undefined }).initiatePayment(input()))
      expect(error).toMatchObject({ type: "not_allowed", code: "AFRIEX_CHECKOUT_NOT_CONFIGURED" })
    })

    it("refuses a currency whose minor unit is not known, unless configured", async () => {
      const service = buildService()
      const xof = { ...input(), currency_code: "xof" }

      expect(await refusal(service.initiatePayment(xof))).toMatchObject({
        code: "AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY",
      })

      const configured = buildService({ checkout: { ...OPTIONS.checkout, minorUnitExponents: { XOF: 0 } } })
      await expect(configured.initiatePayment(xof)).resolves.toMatchObject({
        data: expect.objectContaining({ expectedAmountMinor: "25000", minorUnitExponent: 0 }),
      })
    })

    it("refuses an amount below Afriex's minimum", async () => {
      const error = await refusal(buildService().initiatePayment(input(undefined, {}, "0.5")))
      expect(error.code).toBe("AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY")
    })

    it("refuses when no channel is left for the currency", async () => {
      const service = buildService({
        checkout: { ...OPTIONS.checkout, currencyChannels: { NGN: ["CARD"] } },
      })
      expect((await refusal(service.initiatePayment(input()))).code).toBe(
        "AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY"
      )
    })

    it("refuses a return URL on an origin the store does not allow", async () => {
      const error = await refusal(
        buildService().initiatePayment(input(undefined, { return_url: "https://evil.example/x" }))
      )
      expect(error.code).toBe("AFRIEX_RETURN_URL_NOT_ALLOWED")
    })

    it("skips them for a placeholder the plugin creates to apply a held payment", async () => {
      const service = buildService({ checkout: undefined })

      const result = await service.initiatePayment(input({ stage: "select", purpose: "apply" }))

      expect(result.data).toMatchObject({ stage: "selected" })
      expect(sdk.checkout.createSession).not.toHaveBeenCalled()
    })
  })

  describe("pay stage", () => {
    it("creates the checkout session with exactly what Afriex needs", async () => {
      const service = buildService()

      const result = await service.initiatePayment(input(PAY, {}, "25000.004"))

      expect(sdk.checkout.createSession).toHaveBeenCalledWith({
        amount: 2500000,
        currency: "NGN",
        merchantReference: SESSION_ID,
        redirectUrl: "https://shop.example.com/checkout/afriex/return/order_01",
        customer: CUSTOMER,
        channels: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"],
        metadata: {
          medusa_payment_session_id: SESSION_ID,
          medusa_payment_collection_id: "paycol_01",
          medusa_order_id: "order_01",
          medusa_cart_id: "cart_01",
        },
      })
      expect(result.data).toMatchObject({
        stage: "open",
        merchantReference: SESSION_ID,
        checkoutUrl: "https://pay.afriex.com/pay/abc",
        channelsOffered: ["VIRTUAL_BANK_ACCOUNT"],
        chargedAmount: "25000",
        expiresAtEstimate: expect.any(String),
        afriex: null,
      })
    })

    it("records the link in the ledger", async () => {
      await buildService().initiatePayment(input(PAY))

      expect(eventBus.emit).toHaveBeenCalledWith({
        name: "afriex.payment_reference.created",
        data: expect.objectContaining({
          reference: SESSION_ID,
          method: "checkout",
          payment_collection_id: "paycol_01",
          amount: "25000",
          amount_minor: "2500000",
          currency_code: "NGN",
        }),
      })
    })

    it("hides checkout's bank option when the admin asked and the currency has another way", async () => {
      const service = buildService({
        checkout: { ...OPTIONS.checkout, currencyChannels: { NGN: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"] } },
      })

      await service.initiatePayment(input({ ...PAY, hide_bank: true }))

      expect(sdk.checkout.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["MOBILE_MONEY"] })
      )
    })

    it("keeps the bank option when nothing else is known to collect that currency", async () => {
      const service = buildService({
        checkout: { ...OPTIONS.checkout, currencyChannels: { NGN: ["VIRTUAL_BANK_ACCOUNT"] } },
      })

      await service.initiatePayment(input({ ...PAY, hide_bank: true }))

      expect(sdk.checkout.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["VIRTUAL_BANK_ACCOUNT"] })
      )
    })

    it("offers the bank option after all when Afriex will not collect without it", async () => {
      const service = buildService({
        checkout: { ...OPTIONS.checkout, currencyChannels: { NGN: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"] } },
      })
      sdk.checkout.createSession.mockRejectedValueOnce(
        new ApiError({ code: "NOT_SUPPORTED_ERROR", error: "No requested deposit channel is available for currency NGN" }, 422)
      )

      const result = await service.initiatePayment(input({ ...PAY, hide_bank: true }))

      expect(sdk.checkout.createSession).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ channels: ["MOBILE_MONEY"] })
      )
      expect(sdk.checkout.createSession).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ channels: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"] })
      )
      expect((result.data as any).checkoutUrl).toBe("https://pay.afriex.com/pay/abc")
      expect((result.data as any).channelsRequested).toEqual(["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"])
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/without its bank-transfer option/))
    })

    it("does not retry a 422 that had nothing to do with hiding the bank option", async () => {
      sdk.checkout.createSession.mockRejectedValueOnce(new ApiError({ code: "NOT_SUPPORTED_ERROR" }, 422))

      const error = await refusal(buildService().initiatePayment(input(PAY)))

      expect(error.code).toBe("AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY")
      expect(sdk.checkout.createSession).toHaveBeenCalledTimes(1)
    })

    it("sends only the admin's channels when they chose, within the cap", async () => {
      await buildService().initiatePayment(input({ ...PAY, channels: ["MOBILE_MONEY", "CARD"] }))

      expect(sdk.checkout.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ channels: ["MOBILE_MONEY"] })
      )
    })

    it("shows the shopper Afriex's own message when it refuses the details", async () => {
      sdk.checkout.createSession.mockRejectedValueOnce(
        new ApiError(
          {
            code: "VALIDATION_ERROR",
            error: "bad",
            details: { errorMessage: "PHONE_COUNTRY_MISMATCH", friendlyMessage: "The phone number does not match the customer's country." },
          },
          400
        )
      )

      const error = await refusal(buildService().initiatePayment(input(PAY)))

      expect(error).toMatchObject({
        type: "not_allowed",
        code: "AFRIEX_CHECKOUT_REFUSED",
        message: "The phone number does not match the customer's country.",
      })
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/PHONE_COUNTRY_MISMATCH/))
    })

    it("reports a currency with no channel as unavailable", async () => {
      sdk.checkout.createSession.mockRejectedValueOnce(new ApiError({ code: "X" }, 422))
      expect((await refusal(buildService().initiatePayment(input(PAY)))).code).toBe(
        "AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY"
      )
    })

    it("keeps a bad or under-permissioned key from the shopper and names it in the log", async () => {
      sdk.checkout.createSession.mockRejectedValueOnce(new ApiError({ code: "AUTHENTICATION_ERROR" }, 401))

      const error = await refusal(buildService().initiatePayment(input(PAY)))

      expect(error).toMatchObject({ type: "unexpected_state", code: "AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE" })
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/checkout-session permission/))
    })

    it("does not tell the shopper to try again when the endpoint is not there for this store", async () => {
      for (const failure of [
        new ApiError({ code: "NOT_FOUND_ERROR", error: "Page not found" }, 404),
        new ApiError({ code: "FORBIDDEN", error: "Forbidden" }, 403),
      ]) {
        sdk.checkout.createSession.mockRejectedValueOnce(failure)

        const error = await refusal(buildService().initiatePayment(input(PAY)))

        expect(error).toMatchObject({ type: "not_allowed", code: "AFRIEX_CHECKOUT_NOT_CONFIGURED" })
        expect(error.message).not.toMatch(/try again/i)
      }
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/HTTP 404 NOT_FOUND_ERROR.*Retrying will not help/s)
      )
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/HTTP 403 FORBIDDEN/))
      expect(eventBus.emit).not.toHaveBeenCalled()
    })

    it("lets the shopper retry when Afriex says the reference is already in use", async () => {
      // Afriex's own answer: 409 DUPLICATE_REQUEST, "A checkout session with
      // merchantReference … is already active". The link is not in the body,
      // and the next attempt gets a new session id, so retrying is right.
      sdk.checkout.createSession.mockRejectedValueOnce(
        new ApiError(
          {
            code: "DUPLICATE_REQUEST",
            error: "Duplicate request",
            details: {
              errorMessage: "Duplicate request",
              friendlyMessage: 'A checkout session with merchantReference "payses_01" is already active',
            },
          },
          409
        )
      )

      const error = await refusal(buildService().initiatePayment(input(PAY)))

      expect(error).toMatchObject({
        type: "unexpected_state",
        code: "AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE",
      })
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/already has an active checkout session for reference/)
      )
    })

    it("treats an outage, a timeout or its own SDK's refusal as try-again", async () => {
      for (const failure of [
        new ApiError({}, 503),
        new Error("TimeoutError"),
        new ValidationError("channels contains an unsupported payment channel"),
      ]) {
        sdk.checkout.createSession.mockRejectedValueOnce(failure)
        expect((await refusal(buildService().initiatePayment(input(PAY)))).code).toBe(
          "AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE"
        )
      }
      expect(eventBus.emit).not.toHaveBeenCalled()
    })
  })

  describe("the rest of the lifecycle", () => {
    it("waits through the mobile-money approval step instead of flagging it", async () => {
      const result = await buildService().authorizePayment({
        data: { currentStatus: "CUSTOMER_ACTION_REQUIRED" },
      })
      expect(result.status).toBe("pending_authorization")
    })

    it("captures once the webhook recorded the payment", async () => {
      const result = await buildService().authorizePayment({ data: { currentStatus: "SUCCESS" } })
      expect(result.status).toBe("captured")
    })

    it("passes status writes through, but never changes a link's amount", async () => {
      const service = buildService()
      const data = { expectedAmount: "25000", expectedCurrency: "NGN", currentStatus: "PENDING" }

      await expect(
        service.updatePayment({ amount: 25000, currency_code: "ngn", data })
      ).resolves.toEqual({ data })
      await expect(
        service.updatePayment({ amount: 30000, currency_code: "ngn", data })
      ).rejects.toThrow(/cannot change/)
    })

    it("tells the ledger a link was taken back, and never throws while doing it", async () => {
      const service = buildService()
      eventBus.emit.mockRejectedValueOnce(new Error("bus down"))
      const open = { stage: "open", merchantReference: SESSION_ID }

      await expect(service.deletePayment({ data: open })).resolves.toEqual({ data: open })
      await expect(service.cancelPayment({ data: open })).resolves.toEqual({ data: open })
      await expect(service.deletePayment({ data: { stage: "selected" } })).resolves.toBeDefined()

      expect(eventBus.emit).toHaveBeenCalledTimes(2)
      expect(eventBus.emit).toHaveBeenLastCalledWith({
        name: "afriex.payment_reference.superseded",
        data: { reference: SESSION_ID },
      })
    })

    it("creates no Afriex customer for the shopper", async () => {
      await expect(buildService().createAccountHolder({ context: {} })).resolves.toEqual({})
      expect(sdk.customers.create).not.toHaveBeenCalled()
    })
  })

  describe("options", () => {
    const validate = (checkout: unknown) => () =>
      AfriexCheckoutService.validateOptions({ ...OPTIONS, checkout })

    it("accepts a store without checkout, and a complete checkout block", () => {
      expect(validate(undefined)).not.toThrow()
      expect(
        validate({
          returnUrl: "https://shop.example.com/r/{order_id}",
          allowedReturnOrigins: ["https://m.shop.example.com"],
          channels: ["MOBILE_MONEY", "CARD"],
          currencyChannels: { KES: ["MOBILE_MONEY"] },
          minorUnitExponents: { XOF: 0 },
        })
      ).not.toThrow()
    })

    it("refuses at boot what would only fail at a shopper's checkout", () => {
      expect(validate({ returnUrl: "http://shop.example.com/r" })).toThrow(/returnUrl/)
      expect(validate({ allowedReturnOrigins: ["https://shop.example.com/path"] })).toThrow(/allowedReturnOrigins/)
      expect(validate({ channels: [] })).toThrow(/channels/)
      expect(validate({ channels: ["CASH"] })).toThrow(/channels/)
      expect(validate({ currencyChannels: { NAIRA: ["CARD"] } })).toThrow(/currencyChannels/)
      expect(validate({ minorUnitExponents: { XOF: 1.5 } })).toThrow(/minorUnitExponents/)
      expect(validate("yes")).toThrow(/checkout/)
    })

    it("warns once that card is not sent while the SDK refuses it", () => {
      buildService({ checkout: { ...OPTIONS.checkout, channels: ["CARD", "MOBILE_MONEY"] } })
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/accepts only/))
    })
  })
})
