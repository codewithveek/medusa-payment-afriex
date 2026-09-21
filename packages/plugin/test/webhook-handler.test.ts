import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"

const runWorkflow = vi.hoisted(() => vi.fn(async () => ({ result: {} })))

vi.mock("@medusajs/medusa/core-flows", () => ({
  // The real workflow creates the payment and completes the cart. The mock
  // container simulates that end state so the handler's post-run checks see
  // what Medusa would actually have left behind.
  processPaymentWorkflow: vi.fn((container: any) => ({
    run: async (...args: unknown[]) => {
      container.completeWorkflow?.()
      return runWorkflow(...(args as []))
    },
  })),
}))

import { processAfriexWebhook } from "../src/lib/webhook-handler"
import {
  buildTransactionPayload,
  createMockContainer,
  PROVIDER_ID,
  SESSION_ID,
} from "./mocks/afriex.mock"

function asContainer(mock: ReturnType<typeof createMockContainer>) {
  return mock as unknown as MedusaContainer
}

describe("Afriex webhook handling", () => {
  beforeEach(() => {
    runWorkflow.mockClear()
  })

  it("captures a matching deposit exactly once, however many times it is delivered", async () => {
    const container = createMockContainer()
    const body = JSON.stringify(buildTransactionPayload())

    const first = await processAfriexWebhook(asContainer(container), body, {})
    const second = await processAfriexWebhook(asContainer(container), body, {})

    expect(first.outcome).toBe("captured")
    expect(second.outcome).toBe("duplicate")
    expect(runWorkflow).toHaveBeenCalledTimes(1)
  })

  it("treats a later status change on the same transaction as a new event", async () => {
    const container = createMockContainer()

    await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(
        buildTransactionPayload({ status: "PROCESSING", updatedAt: "2026-09-16T10:01:00.000Z" })
      ),
      {}
    )
    const settled = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload()),
      {}
    )

    expect(settled.outcome).toBe("captured")
    expect(runWorkflow).toHaveBeenCalledTimes(1)
  })

  it("flags an underpayment for review instead of capturing it", async () => {
    const container = createMockContainer({ sessionAmount: 25000 })
    const body = JSON.stringify(
      buildTransactionPayload({ destinationAmount: "20000.00" })
    )

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.outcome).toBe("amount_mismatch")
    expect(runWorkflow).not.toHaveBeenCalled()

    const [update] = container.paymentModule.updatePaymentSession.mock.calls[0]!
    expect(update.status).toBe("requires_more")
    expect(update.data.currentStatus).toBe("AMOUNT_MISMATCH")
    expect(update.data.receivedAmount).toBe("20000.00")
  })

  it("flags a deposit in the wrong currency even when the number matches", async () => {
    const container = createMockContainer({ sessionAmount: 25000, sessionCurrency: "ngn" })
    const body = JSON.stringify(
      buildTransactionPayload({ destinationCurrency: "GHS" })
    )

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.outcome).toBe("amount_mismatch")
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  describe("signature verification", () => {
    it("rejects an unverified payload before reading anything from the database", async () => {
      const container = createMockContainer({ signatureValid: false })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.success).toBe(false)
      expect(result.statusCode).toBe(401)
      expect(container.paymentModule.retrievePaymentSession).not.toHaveBeenCalled()
      expect(container.paymentModule.listPaymentSessions).not.toHaveBeenCalled()
      expect(container.paymentModule.updatePaymentSession).not.toHaveBeenCalled()
      expect(container.webhookModule.createProcessedWebhooks).not.toHaveBeenCalled()
      expect(runWorkflow).not.toHaveBeenCalled()
    })

    it("verifies against every registered Afriex provider, and only those", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(buildTransactionPayload())

      await processAfriexWebhook(asContainer(container), body, { "x-webhook-signature": "sig" })

      const providersTried = container.paymentModule.getWebhookActionAndData.mock.calls.map(
        ([call]) => call.provider
      )
      // Unprefixed: Medusa builds `pp_${provider}` before resolving it from the
      // container, so passing the stored `pp_afriex_afriex` here would send it
      // looking for `pp_pp_afriex_afriex`.
      expect(providersTried).toEqual(["afriex_afriex"])

      const [call] = container.paymentModule.getWebhookActionAndData.mock.calls[0]!
      expect(call.payload.rawData).toBe(body)
      // The request's own headers, plus the marker that tells the provider the
      // event came through this route rather than Medusa's generic endpoint.
      expect(call.payload.headers).toEqual({
        "x-webhook-signature": "sig",
        "x-afriex-plugin-route": "1",
      })
    })

    it("verifies the signature before it looks the session up", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(buildTransactionPayload())

      await processAfriexWebhook(asContainer(container), body, {})

      const verifyOrder =
        container.paymentModule.getWebhookActionAndData.mock.invocationCallOrder[0]!
      const lookupOrder =
        container.paymentModule.retrievePaymentSession.mock.invocationCallOrder[0]!
      expect(verifyOrder).toBeLessThan(lookupOrder)
      expect(container.paymentModule.retrievePaymentSession).toHaveBeenCalledWith(SESSION_ID)
    })

    it("rejects an event signed for one registration but aimed at another registration's session", async () => {
      const container = createMockContainer()
      container.session.provider_id = "pp_afriex_other"
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.statusCode).toBe(401)
      expect(container.webhookModule.createProcessedWebhooks).not.toHaveBeenCalled()
    })
  })

  describe("matching a deposit to a session", () => {
    it("acknowledges events for sessions it does not know about", async () => {
      const container = createMockContainer({ sessionMissing: true })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.success).toBe(true)
      expect(result.outcome).toBe("unknown_session")
      expect(runWorkflow).not.toHaveBeenCalled()
    })

    it("logs a settled deposit that matches no session at error level, since that is money with no home", async () => {
      const container = createMockContainer({ sessionMissing: true })

      await processAfriexWebhook(
        asContainer(container),
        JSON.stringify(buildTransactionPayload({ status: "SUCCESS" })),
        {}
      )
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/SETTLED/))

      container.logger.error.mockClear()
      await processAfriexWebhook(
        asContainer(container),
        JSON.stringify(buildTransactionPayload({ status: "PROCESSING" })),
        {}
      )
      expect(container.logger.error).not.toHaveBeenCalled()
    })

    it("acknowledges a transaction that carries no reference rather than guessing an order", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(
        buildTransactionPayload({ merchantReference: undefined, meta: {}, destinationId: undefined })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("unknown_session")
      expect(container.paymentModule.retrievePaymentSession).not.toHaveBeenCalled()
    })

    it("refuses a reference that is not a string, so nothing but an id ever reaches the lookup", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(
        buildTransactionPayload({
          merchantReference: { id: { $like: "payses_%" } } as unknown as string,
          meta: {},
          destinationId: undefined,
        })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("unknown_session")
      expect(container.paymentModule.retrievePaymentSession).not.toHaveBeenCalled()
    })

    it("still matches by account when the event carries no reference at all", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(
        buildTransactionPayload({
          merchantReference: undefined,
          meta: {},
          sourceId: "pm_virtual_1",
          destinationId: undefined,
        })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      // The only lookup by id is the post-capture check on the matched session,
      // never one keyed on a value from the payload.
      for (const [id] of container.paymentModule.retrievePaymentSession.mock.calls) {
        expect(id).toBe(SESSION_ID)
      }
    })

    it("falls back to the destination account when the reference did not survive, for dedicated accounts", async () => {
      const container = createMockContainer()
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
      )
      const body = JSON.stringify(
        buildTransactionPayload({ merchantReference: "garbled", meta: {}, destinationId: "pm_virtual_1" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.paymentModule.listPaymentSessions).toHaveBeenCalledWith(
        expect.objectContaining({ provider_id: PROVIDER_ID }),
        expect.anything()
      )
    })

    it("recognises the account whether the deposit names it as its source or its destination", async () => {
      const container = createMockContainer()
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
      )
      const body = JSON.stringify(
        buildTransactionPayload({
          merchantReference: "garbled",
          meta: {},
          sourceId: "pm_virtual_1",
          destinationId: "wallet_business",
        })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
    })

    it("does not fall back by account for a pool account, which every shopper shares", async () => {
      const container = createMockContainer({ sessionData: { collectionMethod: "pool" } })
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
      )
      const body = JSON.stringify(
        buildTransactionPayload({ merchantReference: "garbled", meta: {}, destinationId: "pm_virtual_1" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("unknown_session")
      expect(runWorkflow).not.toHaveBeenCalled()
    })

    it("returns 500 when the session lookup fails for any reason other than not-found, so Afriex retries", async () => {
      const container = createMockContainer()
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new Error("connection refused")
      )
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.success).toBe(false)
      expect(result.statusCode).toBe(500)
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/connection refused/))
      expect(container.webhookModule.createProcessedWebhooks).not.toHaveBeenCalled()
    })
  })

  it("ignores events that are not transactions", async () => {
    const container = createMockContainer()
    const body = JSON.stringify({
      event: "CUSTOMER.CREATED",
      data: { customerId: "cus_1" },
    })

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result).toEqual({ success: true, outcome: "ignored" })
  })

  it("records a non-settled status without capturing", async () => {
    const container = createMockContainer()
    const body = JSON.stringify(buildTransactionPayload({ status: "IN_REVIEW" }))

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.outcome).toBe("status_recorded")
    expect(runWorkflow).not.toHaveBeenCalled()

    const [update] = container.paymentModule.updatePaymentSession.mock.calls[0]!
    expect(update.data.currentStatus).toBe("IN_REVIEW")
    expect(update.status).toBe("requires_more")
  })

  it("leaves an in-flight session's status alone on a routine progress event", async () => {
    const container = createMockContainer()
    const body = JSON.stringify(buildTransactionPayload({ status: "PROCESSING" }))

    await processAfriexWebhook(asContainer(container), body, {})

    const [update] = container.paymentModule.updatePaymentSession.mock.calls[0]!
    expect(update.data.currentStatus).toBe("PROCESSING")
    expect(update.status).toBeUndefined()
  })

  describe("once money has moved", () => {
    it("never downgrades a settled session on a late or out-of-order progress event", async () => {
      const container = createMockContainer({
        sessionData: { currentStatus: "SUCCESS", afriexTransactionId: "txn_1" },
      })
      const body = JSON.stringify(
        buildTransactionPayload({ status: "PROCESSING", updatedAt: "2026-09-16T09:59:00.000Z" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("status_recorded")
      expect(container.paymentModule.updatePaymentSession).not.toHaveBeenCalled()
      expect(container.session.data.currentStatus).toBe("SUCCESS")
    })

    it("never downgrades a mismatched session either, since that deposit still needs a human", async () => {
      const container = createMockContainer({
        sessionData: { currentStatus: "AMOUNT_MISMATCH", afriexTransactionId: "txn_1" },
      })
      const body = JSON.stringify(buildTransactionPayload({ status: "PENDING" }))

      await processAfriexWebhook(asContainer(container), body, {})

      expect(container.paymentModule.updatePaymentSession).not.toHaveBeenCalled()
    })

    it("records a second settled transfer on a paid session as an extra deposit instead of losing it", async () => {
      const container = createMockContainer({
        sessionStatus: "captured",
        sessionData: {
          currentStatus: "SUCCESS",
          afriexTransactionId: "txn_1",
          receivedAmount: "25000.00",
        },
      })
      const body = JSON.stringify(
        buildTransactionPayload({ transactionId: "txn_2", updatedAt: "2026-09-16T11:00:00.000Z" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("extra_deposit")
      expect(runWorkflow).not.toHaveBeenCalled()
      expect(container.session.data.currentStatus).toBe("SUCCESS")
      expect(container.session.data.afriexTransactionId).toBe("txn_1")
      expect(container.session.data.extraDeposits).toEqual([
        expect.objectContaining({ transactionId: "txn_2", amount: "25000.00", currency: "NGN" }),
      ])
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/refund/i))
    })

    it("re-runs an idempotent capture when the same settled transaction is delivered again under a new event id", async () => {
      const container = createMockContainer({
        sessionData: { currentStatus: "SUCCESS", afriexTransactionId: "txn_1" },
      })
      const body = JSON.stringify(
        buildTransactionPayload({ updatedAt: "2026-09-16T11:00:00.000Z" }, "TRANSACTION.CREATED")
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.session.data.extraDeposits).toBeUndefined()
    })

    it("keeps a superseded mismatched deposit on record when a corrected transfer captures the order", async () => {
      const container = createMockContainer({
        sessionStatus: "requires_more",
        sessionData: {
          currentStatus: "AMOUNT_MISMATCH",
          afriexTransactionId: "txn_1",
          receivedAmount: "20000.00",
          receivedCurrency: "NGN",
        },
      })
      const body = JSON.stringify(buildTransactionPayload({ transactionId: "txn_2" }))

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.session.data.afriexTransactionId).toBe("txn_2")
      expect(container.session.data.extraDeposits).toEqual([
        expect.objectContaining({ transactionId: "txn_1", amount: "20000.00" }),
      ])
    })
  })

  describe("after the workflow runs", () => {
    it("fails loudly when the workflow left no payment behind, so the event is retried rather than lost", async () => {
      const container = createMockContainer()
      container.completeWorkflow = () => {
        // Simulates the provider having deferred authorization: no payment.
      }
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.success).toBe(false)
      expect(result.statusCode).toBe(500)
      expect(container.processed.size).toBe(0)
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/no payment/))
    })

    it("fails loudly when the cart did not complete into an order", async () => {
      const container = createMockContainer({ cartCompletes: false })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.success).toBe(false)
      expect(result.statusCode).toBe(500)
      expect(container.processed.size).toBe(0)
      expect(container.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/did not complete into an order/)
      )
    })

    it("is satisfied by a payment alone when the collection has no cart to complete", async () => {
      const container = createMockContainer({ hasCart: false, cartCompletes: false })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
    })
  })

  it("releases its claim when reconciliation fails, so the retry is not swallowed", async () => {
    const container = createMockContainer()
    container.paymentModule.updatePaymentSession.mockRejectedValueOnce(
      new Error("database unavailable")
    )
    const body = JSON.stringify(buildTransactionPayload())

    const failed = await processAfriexWebhook(asContainer(container), body, {})
    expect(failed.success).toBe(false)
    expect(failed.statusCode).toBe(500)
    expect(container.processed.size).toBe(0)

    const retried = await processAfriexWebhook(asContainer(container), body, {})
    expect(retried.outcome).toBe("captured")
    expect(runWorkflow).toHaveBeenCalledTimes(1)
  })

  it("rejects a malformed body", async () => {
    const container = createMockContainer()

    const result = await processAfriexWebhook(asContainer(container), "not json", {})

    expect(result).toEqual({
      success: false,
      statusCode: 400,
      error: "Malformed payload",
    })
  })
})
