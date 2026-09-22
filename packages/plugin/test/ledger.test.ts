import { generateKeyPairSync } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"
import { MedusaError } from "@medusajs/framework/utils"

const runWorkflow = vi.hoisted(() => vi.fn(async () => ({ result: {} })))
const createSessions = vi.hoisted(() => vi.fn())

vi.mock("@medusajs/medusa/core-flows", () => ({
  createPaymentSessionsWorkflow: vi.fn(() => ({ run: createSessions })),
  processPaymentWorkflow: vi.fn((container: any) => ({
    run: async (...args: unknown[]) => {
      await container.completeWorkflow?.()
      return runWorkflow(...(args as []))
    },
  })),
}))

const sdk = vi.hoisted(() => ({
  customers: { create: vi.fn(), delete: vi.fn() },
  paymentMethods: { createVirtualAccount: vi.fn(), get: vi.fn(), delete: vi.fn() },
  webhooks: { verifyAndParse: vi.fn() },
}))

vi.mock("../src/lib/afriex", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/afriex")>()),
  createAfriexSdk: () => sdk,
}))

import { processAfriexWebhook } from "../src/lib/webhook-handler"
import {
  findReference,
  recordReference,
  supersedeReference,
} from "../src/lib/ledger"
import { applyLatePayment, AfriexAdminError, resolveHeldSession } from "../src/lib/held-payments"
import AfriexBankTransferService from "../src/providers/afriex-payment/bank-transfer-service"
import referenceSubscriber, { config as subscriberConfig } from "../src/subscribers/afriex-payment-reference"
import { POST as applyRoute } from "../src/api/admin/afriex/references/[reference]/apply/route"
import { POST as resolveRoute } from "../src/api/admin/afriex/sessions/[id]/resolve/route"
import {
  buildTransactionPayload,
  createMockContainer,
  PAYMENT_COLLECTION_ID,
  SESSION_ID,
} from "./mocks/afriex.mock"

function asContainer(mock: ReturnType<typeof createMockContainer>) {
  return mock as unknown as MedusaContainer
}

async function seedReference(
  container: ReturnType<typeof createMockContainer>,
  values: Record<string, unknown> = {}
) {
  return container.paymentsModule.createPaymentReferences({
    reference: "payses_OLD",
    method: "bank_transfer",
    payment_session_id: "payses_OLD",
    payment_collection_id: PAYMENT_COLLECTION_ID,
    amount: "25000",
    currency_code: "NGN",
    account_id: "pm_old",
    amount_minor: null,
    ...values,
  })
}

function heldPayment(transactionId = "txn_late", amount = "25000.00") {
  return {
    transaction_id: transactionId,
    amount,
    currency: "NGN",
    received_at: "2026-09-16T12:00:00.000Z",
    status: "held",
  }
}

async function expectHeldError(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(AfriexAdminError)
  await promise.catch((error: AfriexAdminError) => expect(error.code).toBe(code))
}

beforeEach(() => {
  runWorkflow.mockClear()
  vi.clearAllMocks()
})

describe("one settlement per payment collection", () => {
  it("records a deposit as money to refund when the database says another transaction already paid the order", async () => {
    const container = createMockContainer()
    await container.paymentsModule.createSettlements({
      payment_collection_id: PAYMENT_COLLECTION_ID,
      payment_session_id: "payses_other",
      transaction_id: "txn_other",
    })

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload()),
      {}
    )

    expect(result.outcome).toBe("extra_deposit")
    expect(runWorkflow).not.toHaveBeenCalled()
    expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/already settled by txn_other/))
  })

  it("captures only once even on servers that do not share a lock", async () => {
    const container = createMockContainer({ sharedLock: false })
    const first = JSON.stringify(buildTransactionPayload({ transactionId: "txn_1" }))
    const second = JSON.stringify(
      buildTransactionPayload({ transactionId: "txn_2", updatedAt: "2026-09-16T10:05:01.000Z" })
    )

    const results = await Promise.all([
      processAfriexWebhook(asContainer(container), first, {}),
      processAfriexWebhook(asContainer(container), second, {}),
    ])

    expect(runWorkflow).toHaveBeenCalledTimes(1)
    expect(results.map((r) => r.outcome)).toContain("extra_deposit")
    expect(container.paymentsModule.settlements.size).toBe(1)
  })

  it("lets the same transaction retry a capture that did not finish", async () => {
    const container = createMockContainer()
    await container.paymentsModule.createSettlements({
      payment_collection_id: PAYMENT_COLLECTION_ID,
      payment_session_id: SESSION_ID,
      transaction_id: "txn_1",
    })

    const result = await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload()),
      {}
    )

    expect(result.outcome).toBe("captured")
  })
})

describe("late payments on a session that no longer exists", () => {
  it("holds a settled payment whose reference is in the ledger instead of dropping it", async () => {
    const container = createMockContainer({ sessionMissing: true })
    await seedReference(container)
    const body = JSON.stringify(
      buildTransactionPayload({ merchantReference: "payses_OLD", meta: { reference: "payses_OLD" } })
    )

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result).toEqual({ success: true, outcome: "held" })
    const row = await findReference(asContainer(container), "payses_OLD")
    expect(row?.late_payments).toEqual([
      expect.objectContaining({ transaction_id: "txn_1", amount: "25000.00", status: "held" }),
    ])
    expect(container.logger.error).toHaveBeenCalledWith(expect.stringMatching(/held/))
  })

  it("records a redelivered late payment once", async () => {
    const container = createMockContainer({ sessionMissing: true })
    await seedReference(container)
    const payload = { merchantReference: "payses_OLD", meta: { reference: "payses_OLD" } }

    await processAfriexWebhook(asContainer(container), JSON.stringify(buildTransactionPayload(payload)), {})
    await processAfriexWebhook(
      asContainer(container),
      JSON.stringify(buildTransactionPayload(payload, "TRANSACTION.CREATED")),
      {}
    )

    const row = await findReference(asContainer(container), "payses_OLD")
    expect(row?.late_payments).toHaveLength(1)
  })

  it("does not hold a payment that has not settled", async () => {
    const container = createMockContainer({ sessionMissing: true })
    await seedReference(container)
    const body = JSON.stringify(
      buildTransactionPayload({
        status: "PROCESSING",
        merchantReference: "payses_OLD",
        meta: { reference: "payses_OLD" },
      })
    )

    const result = await processAfriexWebhook(asContainer(container), body, {})

    expect(result.outcome).toBe("unknown_session")
    expect((await findReference(asContainer(container), "payses_OLD"))?.late_payments).toBeNull()
  })
})

describe("the ledger", () => {
  it("records a reference with the collection its session belongs to", async () => {
    const container = createMockContainer()

    await recordReference(asContainer(container), {
      reference: SESSION_ID,
      method: "bank_transfer",
      payment_session_id: SESSION_ID,
      amount: "25000",
      currency_code: "ngn",
      account_id: "pm_virtual_1",
    })

    expect(await findReference(asContainer(container), SESSION_ID)).toMatchObject({
      payment_collection_id: PAYMENT_COLLECTION_ID,
      currency_code: "NGN",
      account_id: "pm_virtual_1",
    })
  })

  it("keeps a reference whose session is already gone", async () => {
    const container = createMockContainer({ sessionMissing: true })

    await recordReference(asContainer(container), {
      reference: SESSION_ID,
      method: "bank_transfer",
      payment_session_id: SESSION_ID,
      amount: "25000",
      currency_code: "NGN",
    })

    expect(await findReference(asContainer(container), SESSION_ID)).toMatchObject({
      payment_collection_id: null,
    })
  })

  it("updates the account when the same reference gets a new one, and marks it superseded", async () => {
    const container = createMockContainer()
    const base = {
      reference: SESSION_ID,
      method: "bank_transfer" as const,
      payment_session_id: SESSION_ID,
      amount: "25000",
      currency_code: "NGN",
    }

    await recordReference(asContainer(container), { ...base, account_id: "pm_1" })
    await recordReference(asContainer(container), { ...base, account_id: "pm_2" })
    await supersedeReference(asContainer(container), { reference: SESSION_ID })

    expect(container.paymentsModule.references.size).toBe(1)
    expect(await findReference(asContainer(container), SESSION_ID)).toMatchObject({
      account_id: "pm_2",
      superseded_at: expect.any(Date),
    })
  })

  it("is written by a subscriber to the providers' events", async () => {
    const container = createMockContainer()

    await referenceSubscriber({
      event: {
        name: "afriex.payment_reference.created",
        data: {
          reference: SESSION_ID,
          method: "bank_transfer",
          payment_session_id: SESSION_ID,
          amount: "25000",
          currency_code: "NGN",
        },
      },
      container: asContainer(container),
      pluginOptions: {},
    } as any)

    expect(subscriberConfig.event).toEqual([
      "afriex.payment_reference.created",
      "afriex.payment_reference.superseded",
    ])
    expect(await findReference(asContainer(container), SESSION_ID)).toBeDefined()
  })
})

describe("the bank-transfer provider announces its references", () => {
  const publicKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).publicKey.export({
    type: "spki",
    format: "pem",
  }) as string
  const options = { apiKey: "sk", environment: "staging" as const, webhookPublicKey: publicKey }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

  beforeEach(() => {
    sdk.customers.create.mockResolvedValue({ customerId: "cus_1" })
    sdk.paymentMethods.createVirtualAccount.mockResolvedValue({
      paymentMethodId: "pm_virtual_1",
      accountNumber: "0123456789",
      reference: SESSION_ID,
    })
    sdk.paymentMethods.delete.mockResolvedValue(undefined)
  })

  it("when it creates an account, and when the session is taken back", async () => {
    const eventBus = { emit: vi.fn(async () => undefined) }
    const service = new (AfriexBankTransferService as any)({ logger, event_bus: eventBus }, options)

    const created = await service.initiatePayment({
      amount: 25000,
      currency_code: "ngn",
      data: { session_id: SESSION_ID },
      context: {},
    })
    await service.deletePayment({ data: created.data })

    expect(eventBus.emit).toHaveBeenNthCalledWith(1, {
      name: "afriex.payment_reference.created",
      data: expect.objectContaining({
        reference: SESSION_ID,
        method: "bank_transfer",
        payment_session_id: SESSION_ID,
        amount: "25000",
        currency_code: "NGN",
        account_id: "pm_virtual_1",
      }),
    })
    expect(eventBus.emit).toHaveBeenNthCalledWith(2, {
      name: "afriex.payment_reference.superseded",
      data: { reference: SESSION_ID },
    })
  })

  it("never fails a payment because the ledger could not be told", async () => {
    const eventBus = { emit: vi.fn(async () => Promise.reject(new Error("bus down"))) }
    const service = new (AfriexBankTransferService as any)({ logger, event_bus: eventBus }, options)

    await expect(
      service.initiatePayment({
        amount: 25000,
        currency_code: "ngn",
        data: { session_id: SESSION_ID },
        context: {},
      })
    ).resolves.toMatchObject({ status: "pending" })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/bus down/))
  })
})

describe("applying a held late payment", () => {
  async function withHeld(
    options: Parameters<typeof createMockContainer>[0] = {},
    payment = heldPayment()
  ) {
    const container = createMockContainer({ orderPlaced: true, ...options })
    const row = await seedReference(container)
    await container.paymentsModule.updatePaymentReferences({ id: row.id, late_payments: [payment] })
    return container
  }

  it("records it on the order's Afriex session and captures it", async () => {
    const container = await withHeld()

    const result = await applyLatePayment(asContainer(container), {
      reference: "payses_OLD",
      transactionId: "txn_late",
      actorId: "user_1",
    })

    expect(result).toEqual({ outcome: "captured", payment_session_id: SESSION_ID })
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    expect(container.session.data).toMatchObject({
      currentStatus: "SUCCESS",
      afriexTransactionId: "txn_late",
      paidViaReference: "payses_OLD",
      resolvedBy: "user_1",
    })
    const row = await findReference(asContainer(container), "payses_OLD")
    expect(row?.late_payments?.[0]).toMatchObject({ status: "applied", applied_to: SESSION_ID })
    expect(container.paymentsModule.settlements.size).toBe(1)
  })

  it("asks for confirmation when the payment differs from what the order expects", async () => {
    const container = await withHeld({}, heldPayment("txn_late", "20000.00"))

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_AMOUNT_DIFFERS"
    )

    const confirmed = await applyLatePayment(asContainer(container), {
      reference: "payses_OLD",
      transactionId: "txn_late",
      confirmAmount: true,
    })
    expect(confirmed.outcome).toBe("captured")
  })

  it("refuses a cancelled order", async () => {
    const container = await withHeld({ orderStatus: "canceled" })

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_ORDER_NOT_PAYABLE"
    )
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("refuses a payment that is not held", async () => {
    const container = await withHeld({}, { ...heldPayment(), status: "applied" })

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_LATE_PAYMENT_NOT_HELD"
    )
  })

  it("refuses when the order has no single unpaid Afriex session to apply it to", async () => {
    const container = await withHeld()
    container.session.provider_id = "pp_stripe_stripe"

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_NO_TARGET_SESSION"
    )
  })

  it("refuses when another transaction already paid the order", async () => {
    const container = await withHeld()
    await container.paymentsModule.createSettlements({
      payment_collection_id: PAYMENT_COLLECTION_ID,
      payment_session_id: SESSION_ID,
      transaction_id: "txn_other",
    })

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_ALREADY_SETTLED"
    )
    expect(runWorkflow).not.toHaveBeenCalled()
  })
})

describe("resolving money a session is holding", () => {
  const mismatch = {
    sessionStatus: "requires_more",
    orderPlaced: true,
    sessionData: {
      currentStatus: "AMOUNT_MISMATCH",
      receivedAmount: "26000.00",
      receivedCurrency: "NGN",
      afriexTransactionId: "txn_1",
    },
  }

  it("accepts a deposit as payment in full and records what came in beyond the total", async () => {
    const container = createMockContainer(mismatch)

    const result = await resolveHeldSession(asContainer(container), {
      sessionId: SESSION_ID,
      action: "accept",
      receivedAmount: "26000",
      actorId: "user_1",
    })

    expect(result.outcome).toBe("captured")
    expect(runWorkflow).toHaveBeenCalledTimes(1)
    expect(container.session.data).toMatchObject({ currentStatus: "SUCCESS", resolvedBy: "user_1" })
    expect(container.session.data.extraDeposits).toEqual([
      expect.objectContaining({ amount: "1000", reason: "excess" }),
    ])
  })

  it("will not accept without the admin confirming what arrived", async () => {
    const container = createMockContainer(mismatch)

    await expectHeldError(
      resolveHeldSession(asContainer(container), { sessionId: SESSION_ID, action: "accept" }),
      "AFRIEX_CONFIRM_RECEIVED_AMOUNT"
    )
    await expectHeldError(
      resolveHeldSession(asContainer(container), {
        sessionId: SESSION_ID,
        action: "accept",
        receivedAmount: "25000",
      }),
      "AFRIEX_CONFIRM_RECEIVED_AMOUNT"
    )
    expect(runWorkflow).not.toHaveBeenCalled()
  })

  it("refunds a deposit and lets the shopper pay again", async () => {
    const container = createMockContainer(mismatch)

    const result = await resolveHeldSession(asContainer(container), {
      sessionId: SESSION_ID,
      action: "refund",
    })

    expect(result.outcome).toBe("refund_recorded")
    expect(container.session.status).toBe("pending_authorization")
    expect(container.session.data).toMatchObject({
      currentStatus: "PENDING",
      receivedAmount: null,
      afriexTransactionId: null,
    })
    expect(container.session.data.extraDeposits).toEqual([
      expect.objectContaining({ transactionId: "txn_1", amount: "26000.00", reason: "refund" }),
    ])
  })

  it("only refunds money that arrived after the order was cancelled", async () => {
    const container = createMockContainer({
      ...mismatch,
      sessionData: { ...mismatch.sessionData, currentStatus: "SETTLED_AFTER_CANCEL" },
    })

    await expectHeldError(
      resolveHeldSession(asContainer(container), {
        sessionId: SESSION_ID,
        action: "accept",
        receivedAmount: "26000",
      }),
      "AFRIEX_ORDER_CANCELLED"
    )

    await resolveHeldSession(asContainer(container), { sessionId: SESSION_ID, action: "refund" })
    expect(container.session.status).toBe("canceled")
    expect(container.session.data.currentStatus).toBe("CANCELLED")
  })

  it("refuses a session that is not holding anything", async () => {
    const container = createMockContainer({ orderPlaced: true })

    await expectHeldError(
      resolveHeldSession(asContainer(container), { sessionId: SESSION_ID, action: "refund" }),
      "AFRIEX_NOTHING_HELD"
    )
  })

  it("refuses to accept when another transaction already paid the order", async () => {
    const container = createMockContainer(mismatch)
    await container.paymentsModule.createSettlements({
      payment_collection_id: PAYMENT_COLLECTION_ID,
      payment_session_id: SESSION_ID,
      transaction_id: "txn_other",
    })

    await expectHeldError(
      resolveHeldSession(asContainer(container), {
        sessionId: SESSION_ID,
        action: "accept",
        receivedAmount: "26000",
      }),
      "AFRIEX_ALREADY_SETTLED"
    )
  })

  it("reports a session that does not exist", async () => {
    const container = createMockContainer()
    container.paymentModule.retrievePaymentSession.mockRejectedValueOnce(
      new MedusaError(MedusaError.Types.NOT_FOUND, "missing")
    )

    await expectHeldError(
      resolveHeldSession(asContainer(container), { sessionId: "payses_nope", action: "refund" }),
      "AFRIEX_SESSION_NOT_FOUND"
    )
  })
})

describe("admin routes", () => {
  function response() {
    const res: any = {}
    res.status = vi.fn(() => res)
    res.json = vi.fn(() => res)
    return res
  }

  it("rejects a malformed request before touching anything", async () => {
    const container = createMockContainer()
    const res = response()

    await resolveRoute(
      { scope: container, params: { id: SESSION_ID }, body: { action: "delete" } } as any,
      res
    )
    await applyRoute(
      { scope: container, params: { reference: "payses_OLD" }, body: {} } as any,
      res
    )

    expect(res.status).toHaveBeenNthCalledWith(1, 400)
    expect(res.status).toHaveBeenNthCalledWith(2, 400)
    expect(container.locking.execute).not.toHaveBeenCalled()
  })

  it("answers a refusal with its code, status and details", async () => {
    const container = createMockContainer({ orderPlaced: true })
    const res = response()

    await resolveRoute(
      {
        scope: container,
        params: { id: SESSION_ID },
        body: { action: "refund" },
        auth_context: { actor_id: "user_1" },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: "AFRIEX_NOTHING_HELD" }))
  })

  it("passes the admin user through to the record", async () => {
    const container = createMockContainer({
      sessionStatus: "requires_more",
      orderPlaced: true,
      sessionData: {
        currentStatus: "AMOUNT_MISMATCH",
        receivedAmount: "25000.00",
        receivedCurrency: "NGN",
        afriexTransactionId: "txn_1",
      },
    })
    const res = response()

    await resolveRoute(
      {
        scope: container,
        params: { id: SESSION_ID },
        body: { action: "accept", received_amount: 25000 },
        auth_context: { actor_id: "user_7" },
      } as any,
      res
    )

    expect(res.status).toHaveBeenCalledWith(200)
    expect(container.session.data.resolvedBy).toBe("user_7")
  })
})

describe("applying a held payment when the order has no Afriex session to take it", () => {
  it("replaces the sessions with a checkout placeholder, once the admin confirms", async () => {
    const container = createMockContainer({
      orderPlaced: true,
      providers: ["pp_stripe_stripe", "pp_afriex_afriex", "pp_afriex-checkout_afriex"],
    })
    container.session.provider_id = "pp_stripe_stripe"
    const row = await seedReference(container)
    await container.paymentsModule.updatePaymentReferences({ id: row.id, late_payments: [heldPayment()] })

    await expectHeldError(
      applyLatePayment(asContainer(container), { reference: "payses_OLD", transactionId: "txn_late" }),
      "AFRIEX_NO_TARGET_SESSION"
    )
    expect(createSessions).not.toHaveBeenCalled()

    createSessions.mockImplementationOnce(async ({ input }: any) => {
      // What Medusa does: deletes the other sessions and creates the new one.
      Object.assign(container.session, {
        id: "payses_placeholder",
        provider_id: input.provider_id,
        payment: undefined,
        data: { method: "checkout", stage: "selected", currentStatus: "PENDING" },
      })
      return { result: { id: "payses_placeholder" } }
    })

    const result = await applyLatePayment(asContainer(container), {
      reference: "payses_OLD",
      transactionId: "txn_late",
      replaceSession: true,
    })

    expect(createSessions).toHaveBeenCalledWith({
      input: {
        payment_collection_id: PAYMENT_COLLECTION_ID,
        provider_id: "pp_afriex-checkout_afriex",
        data: { afriex: { stage: "select", purpose: "apply", order_id: "order_1" } },
      },
    })
    expect(result).toEqual({ outcome: "captured", payment_session_id: "payses_placeholder" })
    expect(container.session.data).toMatchObject({ currentStatus: "SUCCESS", paidViaReference: "payses_OLD" })
  })
})
