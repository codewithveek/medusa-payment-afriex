import { vi } from "vitest"
import type { TransactionWebhookPayload } from "@afriex/sdk"

export const SESSION_ID = "payses_01HTEST"

export function buildTransactionPayload(
  overrides: Partial<TransactionWebhookPayload["data"]> = {},
  event: TransactionWebhookPayload["event"] = "TRANSACTION.UPDATED"
): TransactionWebhookPayload {
  return {
    event,
    data: {
      status: "SUCCESS",
      type: "DEPOSIT",
      sourceAmount: "25000.00",
      sourceCurrency: "NGN",
      destinationAmount: "25000.00",
      destinationCurrency: "NGN",
      destinationId: "pm_virtual_1",
      customerId: "cus_1",
      transactionId: "txn_1",
      merchantReference: SESSION_ID,
      meta: { reference: SESSION_ID },
      createdAt: "2026-09-16T10:00:00.000Z",
      updatedAt: "2026-09-16T10:05:00.000Z",
      ...overrides,
    },
  }
}

export type MockContainer = ReturnType<typeof createMockContainer>

type UpdateCall = {
  id: string
  data: Record<string, any>
  amount: unknown
  currency_code: string
  status?: string
}

type VerifyCall = {
  provider: string
  payload: { data: unknown; rawData: string | Buffer; headers: Record<string, unknown> }
}

export function createMockContainer(
  options: {
    sessionAmount?: number
    sessionCurrency?: string
    sessionMissing?: boolean
    signatureValid?: boolean
  } = {}
) {
  const {
    sessionAmount = 25000,
    sessionCurrency = "ngn",
    sessionMissing = false,
    signatureValid = true,
  } = options

  const session = {
    id: SESSION_ID,
    provider_id: "pp_afriex_afriex",
    amount: sessionAmount,
    currency_code: sessionCurrency,
    status: "pending",
    data: {
      afriexPaymentMethodId: "pm_virtual_1",
      collectionMethod: "dedicated",
      accountNumber: "0123456789",
      reference: SESSION_ID,
      expectedAmount: String(sessionAmount),
      expectedCurrency: sessionCurrency.toUpperCase(),
      currentStatus: "PENDING",
    },
  }

  const paymentModule = {
    retrievePaymentSession: vi.fn(async (_id: string) => {
      if (sessionMissing) {
        throw new Error("Payment session not found")
      }
      return session
    }),
    updatePaymentSession: vi.fn(async (_update: UpdateCall) => session),
    getWebhookActionAndData: vi.fn(async (_event: VerifyCall) =>
      signatureValid
        ? { action: "captured", data: { session_id: SESSION_ID, amount: 25000 } }
        : { action: "not_supported" }
    ),
  }

  // Stands in for the plugin's own table: a Map keyed by event_id, with the
  // same unique-constraint behaviour the real column has.
  const processed = new Map<string, { id: string; event_id: string }>()

  const webhookModule = {
    createProcessedWebhooks: vi.fn(async ({ event_id }: { event_id: string }) => {
      if (processed.has(event_id)) {
        throw Object.assign(new Error("duplicate key value violates unique constraint"), {
          code: "23505",
        })
      }
      const record = { id: `pw_${processed.size + 1}`, event_id }
      processed.set(event_id, record)
      return record
    }),
    listProcessedWebhooks: vi.fn(async ({ event_id }: { event_id: string }) => {
      const found = processed.get(event_id)
      return found ? [found] : []
    }),
    deleteProcessedWebhooks: vi.fn(async (id: string) => {
      for (const [key, value] of processed) {
        if (value.id === id) {
          processed.delete(key)
        }
      }
    }),
  }

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }

  const registry: Record<string, unknown> = {
    payment: paymentModule,
    afriex_webhook: webhookModule,
    logger,
  }

  return {
    resolve: vi.fn((key: string) => registry[key]),
    paymentModule,
    webhookModule,
    logger,
    session,
    processed,
  }
}
