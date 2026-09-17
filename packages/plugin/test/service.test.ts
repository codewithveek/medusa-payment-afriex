import { beforeEach, describe, expect, it, vi } from "vitest"
import type { InitiatePaymentInput } from "@medusajs/framework/types"
import { buildTransactionPayload, SESSION_ID } from "./mocks/afriex.mock"

const sdk = vi.hoisted(() => ({
  customers: { create: vi.fn() },
  paymentMethods: {
    createVirtualAccount: vi.fn(),
    listPoolAccounts: vi.fn(),
    get: vi.fn(),
  },
  webhooks: { verifyAndParse: vi.fn() },
}))

vi.mock("../src/lib/afriex", () => ({
  createAfriexSdk: () => sdk,
}))

import AfriexPaymentProviderService from "../src/providers/afriex-payment/service"

const OPTIONS = {
  apiKey: "sk_test",
  environment: "staging" as const,
  webhookPublicKey: "pub_key",
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}

function buildService(collectionMethod: "dedicated" | "pool" = "dedicated") {
  return new (AfriexPaymentProviderService as any)({ logger }, {
    ...OPTIONS,
    collectionMethod,
  })
}

const VIRTUAL_ACCOUNT = {
  paymentMethodId: "pm_virtual_1",
  customerId: "cus_1",
  channel: "VIRTUAL_BANK_ACCOUNT",
  countryCode: "NG",
  accountNumber: "0123456789",
  accountName: "Afriex / Order",
  reference: SESSION_ID,
  institution: { institutionName: "Providus Bank" },
}

const POOL_ACCOUNT = {
  paymentMethodId: "pm_pool_1",
  customerId: "biz_1",
  channel: "POOL_ACCOUNT",
  countryCode: "NG",
  accountNumber: "9876543210",
  accountName: "Afriex Pool",
  institution: { institutionName: "Providus Bank" },
}

function initiateInput(overrides: Partial<InitiatePaymentInput> = {}): InitiatePaymentInput {
  return {
    amount: 25000,
    currency_code: "ngn",
    data: { session_id: SESSION_ID },
    context: {
      customer: {
        id: "cus_medusa",
        email: "ada@example.com",
        first_name: "Ada",
        last_name: "Lovelace",
        phone: "+2348012345678",
        billing_address: { country_code: "ng" },
      },
    },
    ...overrides,
  } as InitiatePaymentInput
}

describe("AfriexPaymentProviderService", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sdk.customers.create.mockResolvedValue({ customerId: "cus_1" })
    sdk.paymentMethods.createVirtualAccount.mockResolvedValue(VIRTUAL_ACCOUNT)
    sdk.paymentMethods.listPoolAccounts.mockResolvedValue(POOL_ACCOUNT)
  })

  describe("validateOptions", () => {
    it("rejects a registration with no API key", () => {
      expect(() =>
        AfriexPaymentProviderService.validateOptions({ webhookPublicKey: "k" })
      ).toThrow(/apiKey/)
    })

    it("rejects a registration with no webhook public key, which would make every event unverifiable", () => {
      expect(() =>
        AfriexPaymentProviderService.validateOptions({ apiKey: "k" })
      ).toThrow(/webhookPublicKey/)
    })

    it("rejects an unknown collection method", () => {
      expect(() =>
        AfriexPaymentProviderService.validateOptions({
          apiKey: "k",
          webhookPublicKey: "k",
          collectionMethod: "card",
        })
      ).toThrow(/collectionMethod/)
    })
  })

  describe("initiatePayment", () => {
    it("sets the Medusa session id as the Afriex reference, which is what ties a deposit back to the cart", async () => {
      const service = buildService("dedicated")

      const result = await service.initiatePayment(initiateInput())

      expect(sdk.paymentMethods.createVirtualAccount).toHaveBeenCalledWith({
        currency: "NGN",
        customerId: "cus_1",
        country: "NG",
        amount: 25000,
        reference: SESSION_ID,
      })
      expect(result.id).toBe("pm_virtual_1")
      expect(result.status).toBe("pending")
      expect(result.data).toMatchObject({
        reference: SESSION_ID,
        expectedAmount: "25000",
        expectedCurrency: "NGN",
        currentStatus: "PENDING",
        accountNumber: "0123456789",
      })
    })

    it("refuses to initiate without a session id rather than minting an unmatchable account", async () => {
      const service = buildService()

      await expect(
        service.initiatePayment(initiateInput({ data: {} }))
      ).rejects.toThrow(/payment session id/)
      expect(sdk.paymentMethods.createVirtualAccount).not.toHaveBeenCalled()
    })

    it("surfaces an Afriex failure instead of returning a session that can never be paid", async () => {
      const service = buildService()
      sdk.paymentMethods.createVirtualAccount.mockRejectedValueOnce(
        new Error("country not enabled")
      )

      await expect(service.initiatePayment(initiateInput())).rejects.toThrow(
        /country not enabled/
      )
    })

    it("reuses the Afriex customer Medusa already holds instead of registering a duplicate", async () => {
      const service = buildService("dedicated")

      await service.initiatePayment(
        initiateInput({
          context: {
            ...initiateInput().context,
            account_holder: { data: { customerId: "cus_existing" } },
          },
        } as Partial<InitiatePaymentInput>)
      )

      expect(sdk.customers.create).not.toHaveBeenCalled()
      expect(sdk.paymentMethods.createVirtualAccount).toHaveBeenCalledWith(
        expect.objectContaining({ customerId: "cus_existing" })
      )
    })

    it("uses the standing pool account without registering a customer, and tells the shopper to quote the reference", async () => {
      const service = buildService("pool")

      const result = await service.initiatePayment(initiateInput())

      expect(sdk.customers.create).not.toHaveBeenCalled()
      expect(sdk.paymentMethods.listPoolAccounts).toHaveBeenCalledWith({
        country: "NG",
      })
      expect(result.data).toMatchObject({
        afriexPaymentMethodId: "pm_pool_1",
        reference: SESSION_ID,
      })
      expect((result.data as any).instructions.reference).toBe(SESSION_ID)
      expect((result.data as any).instructions.note).toMatch(/reference/i)
    })

    it("rejects an account with no account number, which the customer could not pay into", async () => {
      const service = buildService("pool")
      sdk.paymentMethods.listPoolAccounts.mockResolvedValueOnce({
        paymentMethodId: "pm_pool_1",
      })

      await expect(service.initiatePayment(initiateInput())).rejects.toThrow(
        /account number/
      )
    })
  })

  describe("authorizePayment", () => {
    it("defers authorization while the transfer is outstanding, so the order can still be placed", async () => {
      const service = buildService()

      const result = await service.authorizePayment({
        data: { currentStatus: "PENDING" },
      } as any)

      expect(result.status).toBe("pending_authorization")
    })

    it("authorizes as captured once the deposit has settled", async () => {
      const service = buildService()

      const result = await service.authorizePayment({
        data: { currentStatus: "SUCCESS" },
      } as any)

      expect(result.status).toBe("captured")
    })

    it("does not authorize a mismatched deposit", async () => {
      const service = buildService()

      const result = await service.authorizePayment({
        data: { currentStatus: "AMOUNT_MISMATCH" },
      } as any)

      expect(result.status).toBe("requires_more")
    })
  })

  describe("updatePayment", () => {
    it("passes the session through untouched when the amount has not changed", async () => {
      const service = buildService("dedicated")

      const result = await service.updatePayment({
        amount: 25000,
        currency_code: "ngn",
        data: {
          afriexPaymentMethodId: "pm_virtual_1",
          expectedAmount: "25000",
          expectedCurrency: "NGN",
          currentStatus: "SUCCESS",
        },
      } as any)

      // The webhook handler writes status onto the session through this path.
      // Minting a new account here would move the goalposts mid-payment.
      expect(sdk.paymentMethods.createVirtualAccount).not.toHaveBeenCalled()
      expect((result.data as any).currentStatus).toBe("SUCCESS")
    })

    it("mints a new dedicated account when the cart total changes, since the old one is bound to the old amount", async () => {
      const service = buildService("dedicated")

      const result = await service.updatePayment({
        amount: 30000,
        currency_code: "ngn",
        data: {
          afriexPaymentMethodId: "pm_virtual_1",
          reference: SESSION_ID,
          expectedAmount: "25000",
          expectedCurrency: "NGN",
          currentStatus: "PENDING",
        },
        context: initiateInput().context,
      } as any)

      expect(sdk.paymentMethods.createVirtualAccount).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 30000, reference: SESSION_ID })
      )
      expect((result.data as any).expectedAmount).toBe("30000")
    })

    it("only updates the expected amount for a pool account, which is not bound to one", async () => {
      const service = buildService("pool")

      const result = await service.updatePayment({
        amount: 30000,
        currency_code: "ngn",
        data: {
          afriexPaymentMethodId: "pm_pool_1",
          expectedAmount: "25000",
          expectedCurrency: "NGN",
        },
      } as any)

      expect(sdk.paymentMethods.createVirtualAccount).not.toHaveBeenCalled()
      expect((result.data as any).expectedAmount).toBe("30000")
    })
  })

  describe("getWebhookActionAndData", () => {
    it("maps a settled deposit onto a capture, carrying the session id from the reference", async () => {
      const service = buildService()
      const payload = buildTransactionPayload()
      sdk.webhooks.verifyAndParse.mockReturnValueOnce(payload)

      const result = await service.getWebhookActionAndData({
        data: payload as any,
        rawData: JSON.stringify(payload),
        headers: { "x-webhook-signature": "sig" },
      })

      expect(result.action).toBe("captured")
      expect(result.data?.session_id).toBe(SESSION_ID)
      expect(Number(result.data?.amount)).toBe(25000)
    })

    it("returns not_supported when the signature does not verify", async () => {
      const service = buildService()
      sdk.webhooks.verifyAndParse.mockImplementationOnce(() => {
        throw new Error("bad signature")
      })

      const result = await service.getWebhookActionAndData({
        data: {},
        rawData: "{}",
        headers: { "x-webhook-signature": "nope" },
      })

      expect(result.action).toBe("not_supported")
      expect(result.data).toBeUndefined()
    })

    it("returns not_supported when no signature header is present", async () => {
      const service = buildService()

      const result = await service.getWebhookActionAndData({
        data: {},
        rawData: "{}",
        headers: {},
      })

      expect(result.action).toBe("not_supported")
      expect(sdk.webhooks.verifyAndParse).not.toHaveBeenCalled()
    })

    it("ignores events that are not transactions", async () => {
      const service = buildService()
      sdk.webhooks.verifyAndParse.mockReturnValueOnce({
        event: "CUSTOMER.CREATED",
        data: { customerId: "cus_1" },
      })

      const result = await service.getWebhookActionAndData({
        data: {},
        rawData: "{}",
        headers: { "x-webhook-signature": "sig" },
      })

      expect(result.action).toBe("not_supported")
    })
  })

  it("refuses refunds loudly, since v1 cannot perform them", async () => {
    const service = buildService()

    await expect(service.refundPayment({ amount: 100, data: {} } as any)).rejects.toThrow(
      /not supported/i
    )
  })

  it("reads status from what the webhook recorded rather than calling Afriex", async () => {
    const service = buildService()

    const result = await service.getPaymentStatus({
      data: { currentStatus: "IN_REVIEW" },
    } as any)

    expect(result.status).toBe("requires_more")
    expect(sdk.paymentMethods.get).not.toHaveBeenCalled()
  })
})
