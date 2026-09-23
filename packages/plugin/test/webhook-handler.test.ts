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
      await container.completeWorkflow?.()
      return runWorkflow(...(args as []))
    },
  })),
}))

import { processAfriexWebhook } from "../src/lib/webhook-handler"
import {
  buildCheckoutSessionPayload,
  buildTransactionPayload,
  CHECKOUT_PROVIDER_ID,
  createMockContainer,
  PAYMENT_COLLECTION_ID,
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

    describe("with bank transfer and checkout sharing one Afriex webhook key", () => {
      const orders = [
        [PROVIDER_ID, CHECKOUT_PROVIDER_ID],
        [CHECKOUT_PROVIDER_ID, PROVIDER_ID],
      ]

      for (const listed of orders) {
        for (const owner of [PROVIDER_ID, CHECKOUT_PROVIDER_ID]) {
          it(`settles a ${owner} session when the providers are listed as ${listed.join(", ")}`, async () => {
            const container = createMockContainer({ providers: ["pp_stripe_stripe", ...listed] })
            container.session.provider_id = owner
            const body = JSON.stringify(buildTransactionPayload())

            const result = await processAfriexWebhook(asContainer(container), body, {})

            expect(result.outcome).toBe("captured")
            const tried = container.paymentModule.getWebhookActionAndData.mock.calls.map(
              ([call]) => call.provider
            )
            expect(tried.sort()).toEqual(["afriex-checkout_afriex", "afriex_afriex"])
          })
        }
      }
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
        expect.objectContaining({ provider_id: [PROVIDER_ID] }),
        expect.anything()
      )
    })

    it("scans only bank-transfer sessions when falling back by account, since only they own an account", async () => {
      const container = createMockContainer({
        providers: [CHECKOUT_PROVIDER_ID, PROVIDER_ID],
      })
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
      )
      const body = JSON.stringify(
        buildTransactionPayload({ merchantReference: "garbled", meta: {}, destinationId: "pm_virtual_1" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.paymentModule.listPaymentSessions).toHaveBeenCalledWith(
        expect.objectContaining({ provider_id: [PROVIDER_ID] }),
        expect.anything()
      )
    })

    it("does not fall back by account at all when no bank-transfer provider is registered", async () => {
      const container = createMockContainer({ providers: [CHECKOUT_PROVIDER_ID] })
      container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
        new MedusaError(MedusaError.Types.NOT_FOUND, "not found")
      )
      const body = JSON.stringify(
        buildTransactionPayload({ merchantReference: "garbled", meta: {}, destinationId: "pm_virtual_1" })
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("unknown_session")
      expect(container.paymentModule.listPaymentSessions).not.toHaveBeenCalled()
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

    it("does not fall back by account to a session whose account was not minted for it", async () => {
      const container = createMockContainer({ sessionData: { collectionMethod: undefined } })
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

    it("captures once and records the other as an extra deposit when two different transfers settle at the same moment", async () => {
      const container = createMockContainer()
      const first = JSON.stringify(buildTransactionPayload({ transactionId: "txn_1" }))
      const second = JSON.stringify(
        buildTransactionPayload({ transactionId: "txn_2", updatedAt: "2026-09-16T10:05:01.000Z" })
      )

      const results = await Promise.all([
        processAfriexWebhook(asContainer(container), first, {}),
        processAfriexWebhook(asContainer(container), second, {}),
      ])

      expect(results.map((r) => r.outcome).sort()).toEqual(["captured", "extra_deposit"])
      expect(runWorkflow).toHaveBeenCalledTimes(1)
      expect(container.session.data.extraDeposits).toHaveLength(1)
      expect(container.locking.execute).toHaveBeenCalledWith(
        `afriex:payment-collection:${PAYMENT_COLLECTION_ID}`,
        expect.any(Function),
        expect.objectContaining({ timeout: expect.any(Number) })
      )
    })

    it("keeps an extra deposit recorded while the first capture is still running", async () => {
      const container = createMockContainer()
      // Medusa's authorization reads the session data when it starts and writes
      // that snapshot back when it finishes. Anything written in between is lost
      // unless nothing else can write in between.
      const finish = container.completeWorkflow
      container.completeWorkflow = async () => {
        const snapshot = { ...container.session.data }
        await new Promise((resolve) => setTimeout(resolve, 5))
        container.session.data = snapshot
        finish()
      }
      const first = JSON.stringify(buildTransactionPayload({ transactionId: "txn_1" }))
      const second = JSON.stringify(
        buildTransactionPayload({ transactionId: "txn_2", updatedAt: "2026-09-16T10:05:01.000Z" })
      )

      const firstDelivery = processAfriexWebhook(asContainer(container), first, {})
      await new Promise((resolve) => setTimeout(resolve, 1))
      const results = await Promise.all([
        firstDelivery,
        processAfriexWebhook(asContainer(container), second, {}),
      ])

      expect(results.map((r) => r.outcome).sort()).toEqual(["captured", "extra_deposit"])
      expect(container.session.data.extraDeposits).toEqual([
        expect.objectContaining({ transactionId: "txn_2" }),
      ])
    })

    it("records money paid through a second session of an already-paid collection as an extra deposit", async () => {
      const container = createMockContainer({
        siblingSessions: [{ id: "payses_other", payment: { id: "pay_0" } }],
      })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("extra_deposit")
      expect(runWorkflow).not.toHaveBeenCalled()
      expect(container.session.data.extraDeposits).toEqual([
        expect.objectContaining({ transactionId: "txn_1" }),
      ])
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/another session/))
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

  describe("after the order total changed", () => {
    it("holds a deposit sized for the old total instead of capturing it", async () => {
      const container = createMockContainer({ sessionAmount: 25000, collectionAmount: 30000 })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("collection_amount_changed")
      expect(runWorkflow).not.toHaveBeenCalled()
      expect(container.session.status).toBe("requires_more")
      expect(container.session.data).toMatchObject({
        currentStatus: "COLLECTION_AMOUNT_CHANGED",
        receivedAmount: "25000.00",
      })
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/25000 to 30000/))
    })

    it("still treats a redelivery for an order paid before the edit as already captured", async () => {
      const container = createMockContainer({
        sessionAmount: 25000,
        collectionAmount: 30000,
        sessionStatus: "captured",
        sessionData: { currentStatus: "SUCCESS", afriexTransactionId: "txn_1", receivedAmount: "25000.00" },
      })
      const body = JSON.stringify(
        buildTransactionPayload({ updatedAt: "2026-09-16T11:00:00.000Z" }, "TRANSACTION.CREATED")
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.session.data.currentStatus).toBe("SUCCESS")
    })
  })

  describe("after the order was cancelled", () => {
    it("holds a deposit that settles on a cancelled order instead of capturing it", async () => {
      const container = createMockContainer({ collectionStatus: "canceled" })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("settled_after_cancel")
      expect(runWorkflow).not.toHaveBeenCalled()
      expect(container.session.status).toBe("requires_more")
      expect(container.session.data).toMatchObject({
        currentStatus: "SETTLED_AFTER_CANCEL",
        receivedAmount: "25000.00",
        afriexTransactionId: "txn_1",
      })
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/cancelled.*refund/i))
    })

    it("holds a deposit when the order was cancelled, even if the collection no longer says so", async () => {
      // Authorizing any session recomputes the collection's status, which
      // overwrites "canceled" with "awaiting". The order still says cancelled.
      const container = createMockContainer({
        orderPlaced: true,
        orderStatus: "canceled",
        collectionStatus: "awaiting",
      })
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("settled_after_cancel")
      expect(runWorkflow).not.toHaveBeenCalled()
      expect(container.session.data.currentStatus).toBe("SETTLED_AFTER_CANCEL")
    })

    it("flags a capture that landed after the order was cancelled mid-way", async () => {
      // The order was open when the deposit was checked; the admin cancelled
      // it while the capture ran.
      const container = createMockContainer({ orderPlaced: true })
      const finish = container.completeWorkflow
      container.completeWorkflow = () => {
        container.order.status = "canceled"
        finish()
      }
      const body = JSON.stringify(buildTransactionPayload())

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("settled_after_cancel")
      expect(runWorkflow).toHaveBeenCalledTimes(1)
      expect(container.session.data.currentStatus).toBe("SETTLED_AFTER_CANCEL")
      expect(container.session.status).toBe("authorized")
      expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/cancelled.*refund/i))
    })

    it("does not flag a redelivery for an order that was paid first and cancelled later", async () => {
      const container = createMockContainer({
        sessionStatus: "captured",
        sessionData: { currentStatus: "SUCCESS", afriexTransactionId: "txn_1", receivedAmount: "25000.00" },
        collectionStatus: "canceled",
        orderStatus: "canceled",
      })
      const body = JSON.stringify(
        buildTransactionPayload({ updatedAt: "2026-09-16T11:00:00.000Z" }, "TRANSACTION.CREATED")
      )

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("captured")
      expect(container.session.data.currentStatus).toBe("SUCCESS")
    })

    it("keeps an earlier held deposit when a second one settles on the cancelled order", async () => {
      const container = createMockContainer({
        collectionStatus: "canceled",
        sessionStatus: "requires_more",
        sessionData: {
          currentStatus: "SETTLED_AFTER_CANCEL",
          afriexTransactionId: "txn_1",
          receivedAmount: "25000.00",
          receivedCurrency: "NGN",
        },
      })
      const body = JSON.stringify(buildTransactionPayload({ transactionId: "txn_2" }))

      const result = await processAfriexWebhook(asContainer(container), body, {})

      expect(result.outcome).toBe("settled_after_cancel")
      expect(container.session.data.afriexTransactionId).toBe("txn_2")
      expect(container.session.data.extraDeposits).toEqual([
        expect.objectContaining({ transactionId: "txn_1", amount: "25000.00" }),
      ])
    })

    it("does not let a late progress event overwrite it", async () => {
      const container = createMockContainer({
        sessionStatus: "requires_more",
        sessionData: { currentStatus: "SETTLED_AFTER_CANCEL", afriexTransactionId: "txn_1" },
      })
      const body = JSON.stringify(
        buildTransactionPayload({ status: "PROCESSING", updatedAt: "2026-09-16T12:00:00.000Z" })
      )

      await processAfriexWebhook(asContainer(container), body, {})

      expect(container.session.data.currentStatus).toBe("SETTLED_AFTER_CANCEL")
      expect(container.paymentModule.updatePaymentSession).not.toHaveBeenCalled()
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

  describe("a redelivery that overlaps the first attempt", () => {
    it("asks Afriex to retry later while the first delivery is still being processed", async () => {
      const container = createMockContainer()
      const payload = buildTransactionPayload()
      const eventId = `TRANSACTION.UPDATED:${payload.data.transactionId}:${payload.data.status}:${payload.data.updatedAt}`
      container.processed.set(eventId, {
        id: "pw_running",
        event_id: eventId,
        processed_at: new Date(),
        completed_at: null,
      })

      const result = await processAfriexWebhook(asContainer(container), JSON.stringify(payload), {})

      expect(result.success).toBe(false)
      expect(result.statusCode).toBe(503)
      expect(runWorkflow).not.toHaveBeenCalled()
    })

    it("takes over a claim whose delivery died without finishing it", async () => {
      const container = createMockContainer()
      const payload = buildTransactionPayload()
      const eventId = `TRANSACTION.UPDATED:${payload.data.transactionId}:${payload.data.status}:${payload.data.updatedAt}`
      container.processed.set(eventId, {
        id: "pw_crashed",
        event_id: eventId,
        processed_at: new Date(Date.now() - 10 * 60 * 1000),
        completed_at: null,
      })

      const result = await processAfriexWebhook(asContainer(container), JSON.stringify(payload), {})

      expect(result.outcome).toBe("captured")
      expect(container.processed.get(eventId)?.completed_at).toBeInstanceOf(Date)
    })

    it("answers a redelivery of a finished event as a duplicate", async () => {
      const container = createMockContainer()
      const body = JSON.stringify(buildTransactionPayload())

      await processAfriexWebhook(asContainer(container), body, {})
      const again = await processAfriexWebhook(asContainer(container), body, {})

      expect(again).toEqual({ success: true, outcome: "duplicate" })
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

describe("Afriex Checkout sessions", () => {
  function checkoutContainer(options: Parameters<typeof createMockContainer>[0] = {}) {
    const container = createMockContainer({
      providers: [PROVIDER_ID, CHECKOUT_PROVIDER_ID],
      orderPlaced: true,
      sessionStatus: "pending_authorization",
      ...options,
      sessionData: {
        method: "checkout",
        stage: "open",
        merchantReference: SESSION_ID,
        chargedAmount: "25000",
        expectedAmountMinor: "2500000",
        ...options.sessionData,
      },
    })
    container.session.provider_id = CHECKOUT_PROVIDER_ID
    return container
  }

  beforeEach(() => {
    runWorkflow.mockClear()
  })

  it("waits through the mobile-money approval step instead of flagging it for review", async () => {
    const container = checkoutContainer()
    const body = JSON.stringify(
      buildTransactionPayload({
        status: "CUSTOMER_ACTION_REQUIRED",
        channel: "MOBILE_MONEY",
        meta: { reference: SESSION_ID, otpRequired: true } as any,
      })
    )

    await processAfriexWebhook(asContainer(container), body, {})

    expect(container.session.status).toBe("pending_authorization")
    expect(container.session.data).toMatchObject({
      currentStatus: "CUSTOMER_ACTION_REQUIRED",
      lastChannel: "MOBILE_MONEY",
      transactions: [
        expect.objectContaining({ status: "CUSTOMER_ACTION_REQUIRED", channel: "MOBILE_MONEY", otpRequired: true }),
      ],
    })
  })

  it("still flags the same status on a bank-transfer session", async () => {
    const container = createMockContainer({ sessionStatus: "pending_authorization" })
    const body = JSON.stringify(buildTransactionPayload({ status: "CUSTOMER_ACTION_REQUIRED" }))

    await processAfriexWebhook(asContainer(container), body, {})

    expect(container.session.status).toBe("requires_more")
  })

  it("keeps Afriex's failure reason, and asks a person to look at a failed hosted bank transfer", async () => {
    const container = checkoutContainer()
    const body = JSON.stringify(
      buildTransactionPayload({
        status: "FAILED",
        channel: "VIRTUAL_BANK_ACCOUNT",
        meta: {
          reference: SESSION_ID,
          failureReason: { code: "AFX_INVALID_AMOUNT", message: "The amount sent did not match.", retryable: false },
        } as any,
      })
    )

    await processAfriexWebhook(asContainer(container), body, {})

    expect(container.session.status).toBe("error")
    expect(container.session.data).toMatchObject({
      currentStatus: "FAILED",
      failureReason: expect.objectContaining({ code: "AFX_INVALID_AMOUNT", message: "The amount sent did not match." }),
      needsAttention: "possible_wrong_amount_transfer",
    })
  })

  it("keeps the failed attempt on record when the shopper then pays on the same link", async () => {
    const container = checkoutContainer()

    await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(
        buildTransactionPayload({ transactionId: "txn_card_1", status: "FAILED", channel: "CARD" })
      ),
      {}
    )
    const paid = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(
        buildTransactionPayload({ transactionId: "txn_momo_2", channel: "MOBILE_MONEY", updatedAt: "2026-09-16T10:09:00.000Z" })
      ),
      {}
    )

    expect(paid.outcome).toBe("captured")
    expect(container.session.data.paidChannel).toBe("MOBILE_MONEY")
    expect(container.session.data.transactions.map((t: any) => `${t.transactionId}:${t.status}`)).toEqual([
      "txn_card_1:FAILED",
      "txn_momo_2:SUCCESS",
    ])
  })

  it("checks the deposit against the rounded amount the shopper was actually charged", async () => {
    const container = checkoutContainer({ sessionAmount: 25000.004 as any })

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload({ destinationAmount: "25000.00" })),
      {}
    )

    expect(result.outcome).toBe("captured")
  })

  it("holds a checkout deposit that does not match what was charged", async () => {
    const container = checkoutContainer()

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload({ destinationAmount: "24000.00" })),
      {}
    )

    expect(result.outcome).toBe("amount_mismatch")
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})

describe("what Afriex reports about a payment link", () => {
  function linkContainer(options: Parameters<typeof createMockContainer>[0] = {}) {
    const container = createMockContainer({
      providers: [PROVIDER_ID, CHECKOUT_PROVIDER_ID],
      orderPlaced: true,
      sessionStatus: "pending_authorization",
      ...options,
      sessionData: {
        method: "checkout",
        stage: "open",
        merchantReference: SESSION_ID,
        chargedAmount: "25000",
        expiresAtEstimate: "2026-09-16T10:15:00.000Z",
        ...options.sessionData,
      },
    })
    container.session.provider_id = CHECKOUT_PROVIDER_ID
    return container
  }

  /** The ledger row the pay stage writes when it hands the link out. */
  async function withLedgerRow(container: ReturnType<typeof linkContainer>) {
    await container.paymentsModule.createPaymentReferences({
      reference: SESSION_ID,
      method: "checkout",
      payment_session_id: SESSION_ID,
      payment_collection_id: PAYMENT_COLLECTION_ID,
      amount: "25000",
      currency_code: "NGN",
    })
  }

  beforeEach(() => {
    runWorkflow.mockClear()
  })

  it("replaces the assumed expiry with the one Afriex reported, on the session and the ledger", async () => {
    const container = linkContainer()
    await withLedgerRow(container)

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildCheckoutSessionPayload()),
      {}
    )

    expect(result).toMatchObject({ success: true, outcome: "checkout_session_recorded" })
    expect(container.session.data).toMatchObject({
      expiresAt: "2026-09-16T10:30:00.000Z",
      checkoutSessionId: "cs_afriex_1",
      // The link itself is untouched: this event only says when it dies.
      stage: "open",
      merchantReference: SESSION_ID,
    })
    expect([...container.paymentsModule.references.values()][0]).toMatchObject({
      afriex_session_id: "cs_afriex_1",
      expires_at: new Date("2026-09-16T10:30:00.000Z"),
    })
  })

  it("never captures, even when the event says the link has been paid", async () => {
    const container = linkContainer()
    await withLedgerRow(container)

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(
        buildCheckoutSessionPayload({
          paidAt: "2026-09-16T10:12:00.000Z",
          afriexTransactionId: "txn_paid_1",
        })
      ),
      {}
    )

    expect(result.outcome).toBe("checkout_session_recorded")
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(container.session.status).toBe("pending_authorization")
    expect(container.session.data).not.toMatchObject({ currentStatus: "SUCCESS" })
  })

  it("asks Afriex to deliver it again when it arrives before the link was saved", async () => {
    // Afriex fires this in the same call that creates the session, which can
    // beat the pay request still writing the link.
    const container = linkContainer({ sessionData: { stage: "selected", merchantReference: null } })
    await withLedgerRow(container)

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildCheckoutSessionPayload()),
      {}
    )

    expect(result).toMatchObject({ success: false, statusCode: 503 })
    // The ledger still took what it could, and the claim was handed back.
    expect([...container.paymentsModule.references.values()][0]).toMatchObject({
      afriex_session_id: "cs_afriex_1",
    })
    expect(container.session.data).not.toMatchObject({ checkoutSessionId: "cs_afriex_1" })

    // The retry, once the link is saved, is not treated as a duplicate.
    container.session.data = {
      ...container.session.data,
      stage: "open",
      merchantReference: SESSION_ID,
    }
    const retry = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildCheckoutSessionPayload()),
      {}
    )
    expect(retry.outcome).toBe("checkout_session_recorded")
  })

  it("records one delivery once, and the paid re-send as its own event", async () => {
    const container = linkContainer()
    await withLedgerRow(container)
    const body = JSON.stringify(buildCheckoutSessionPayload())

    expect((await processAfriexWebhook(asContainer(container), body, {})).outcome).toBe(
      "checkout_session_recorded"
    )
    expect((await processAfriexWebhook(asContainer(container), body, {})).outcome).toBe("duplicate")

    const paid = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildCheckoutSessionPayload({ paidAt: "2026-09-16T10:12:00.000Z" })),
      {}
    )
    expect(paid.outcome).toBe("checkout_session_recorded")
  })

  it("refuses one that does not verify, and ignores one with nothing to attach", async () => {
    const unsigned = await processAfriexWebhook(
      asContainer(linkContainer({ signatureValid: false })),
      JSON.stringify(buildCheckoutSessionPayload()),
      {}
    )
    expect(unsigned).toMatchObject({ success: false, statusCode: 401 })

    const noReference = await processAfriexWebhook(
      asContainer(linkContainer()),
      JSON.stringify(buildCheckoutSessionPayload({ merchantReference: undefined })),
      {}
    )
    expect(noReference.outcome).toBe("ignored")
  })
})
