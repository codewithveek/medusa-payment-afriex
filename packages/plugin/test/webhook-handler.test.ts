import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"

const runWorkflow = vi.hoisted(() => vi.fn(async () => ({ result: {} })))

vi.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflow: vi.fn(() => ({ run: runWorkflow })),
}))

import { processAfriexWebhook } from "../src/lib/webhook-handler"
import { buildTransactionPayload, createMockContainer, SESSION_ID } from "./mocks/afriex.mock"

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

  it("rejects an unverified payload without touching the session or the store", async () => {
    const container = createMockContainer({ signatureValid: false })
    const body = JSON.stringify(buildTransactionPayload())

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.success).toBe(false)
    expect(result.statusCode).toBe(401)
    expect(container.paymentModule.updatePaymentSession).not.toHaveBeenCalled()
    expect(container.webhookModule.createProcessedWebhooks).not.toHaveBeenCalled()
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("acknowledges events for sessions it does not know about", async () => {
    const container = createMockContainer({ sessionMissing: true })
    const body = JSON.stringify(buildTransactionPayload())

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.success).toBe(true)
    expect(result.outcome).toBe("unknown_session")
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("acknowledges a transaction that carries no reference rather than guessing an order", async () => {
    const container = createMockContainer()
    const body = JSON.stringify(
      buildTransactionPayload({ merchantReference: undefined, meta: {} })
    )

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.outcome).toBe("unknown_session")
    expect(container.paymentModule.retrievePaymentSession).not.toHaveBeenCalled()
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

  it("passes the session it resolved to the provider for verification", async () => {
    const container = createMockContainer()
    const body = JSON.stringify(buildTransactionPayload())

    await processAfriexWebhook(asContainer(container), body, { "x-webhook-signature": "sig" })

    const [call] = container.paymentModule.getWebhookActionAndData.mock.calls[0]!
    expect(call.provider).toBe("pp_afriex_afriex")
    expect(call.payload.rawData).toBe(body)
    expect(call.payload.headers).toEqual({ "x-webhook-signature": "sig" })
    expect(container.paymentModule.retrievePaymentSession).toHaveBeenCalledWith(SESSION_ID)
  })
})
