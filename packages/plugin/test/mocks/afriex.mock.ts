import { vi } from "vitest"
import type { TransactionWebhookPayload } from "@afriex/sdk"
import { MedusaError } from "@medusajs/framework/utils"

export const SESSION_ID = "payses_01HTEST"
export const PROVIDER_ID = "pp_afriex_afriex"
export const PAYMENT_COLLECTION_ID = "paycol_01HTEST"
export const CART_ID = "cart_01HTEST"

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
    sessionData?: Record<string, unknown>
    sessionStatus?: string
    signatureValid?: boolean
    /** Simulates the workflow completing the cart (default) or leaving it uncompleted. */
    cartCompletes?: boolean
    /** Simulates a payment collection with no cart behind it. */
    hasCart?: boolean
  } = {}
) {
  const {
    sessionAmount = 25000,
    sessionCurrency = "ngn",
    sessionMissing = false,
    sessionData = {},
    sessionStatus = "pending",
    signatureValid = true,
    cartCompletes = true,
    hasCart = true,
  } = options

  const session: Record<string, any> = {
    id: SESSION_ID,
    provider_id: PROVIDER_ID,
    payment_collection_id: PAYMENT_COLLECTION_ID,
    amount: sessionAmount,
    currency_code: sessionCurrency,
    status: sessionStatus,
    payment: undefined as undefined | { id: string },
    data: {
      afriexPaymentMethodId: "pm_virtual_1",
      collectionMethod: "dedicated",
      accountNumber: "0123456789",
      reference: SESSION_ID,
      expectedAmount: String(sessionAmount),
      expectedCurrency: sessionCurrency.toUpperCase(),
      currentStatus: "PENDING",
      ...sessionData,
    },
  }

  let orderExists = false

  const paymentModule = {
    retrievePaymentSession: vi.fn(async (_id: string) => {
      if (sessionMissing) {
        throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment session not found")
      }
      return session
    }),
    listPaymentSessions: vi.fn(async () => (sessionMissing ? [] : [session])),
    listPaymentProviders: vi.fn(async () => [
      { id: "pp_stripe_stripe" },
      { id: PROVIDER_ID },
    ]),
    updatePaymentSession: vi.fn(async (update: UpdateCall) => {
      session.data = update.data
      if (update.status) {
        session.status = update.status
      }
      return session
    }),
    getWebhookActionAndData: vi.fn(async (_event: VerifyCall) =>
      signatureValid
        ? { action: "captured", data: { session_id: SESSION_ID, amount: 25000 } }
        : { action: "not_supported" }
    ),
  }

  /** What the mocked workflow does when it runs: creates the payment and, by default, the order. */
  const completeWorkflow = () => {
    session.payment = { id: "pay_1" }
    session.status = "authorized"
    if (cartCompletes) {
      orderExists = true
    }
  }

  const query = {
    graph: vi.fn(async ({ entity }: { entity: string }) => {
      if (entity === "cart_payment_collection") {
        return { data: hasCart ? [{ cart_id: CART_ID }] : [] }
      }
      if (entity === "order_cart") {
        return { data: orderExists ? [{ order_id: "order_1" }] : [] }
      }
      return { data: [] }
    }),
  }

  // Stands in for the plugin's own table: a Map keyed by event_id, with the
  // same unique-constraint behaviour the real column has.
  const processed = new Map<string, { id: string; event_id: string }>()

  const webhookModule = {
    createProcessedWebhooks: vi.fn(async ({ event_id }: { event_id: string }) => {
      if (processed.has(event_id)) {
        // Medusa's generated module service swallows the Postgres unique
        // violation and rethrows this instead — no `code`, no constraint name.
        // The mock has to match, or the duplicate path is only ever tested
        // against an error the plugin never actually sees.
        throw Object.assign(
          new Error(
            `Afriex processed webhook with event_id: ${event_id}, already exists.`
          ),
          { type: "invalid_data" }
        )
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
    query,
  }

  return {
    resolve: vi.fn((key: string) => registry[key]),
    paymentModule,
    webhookModule,
    query,
    logger,
    session,
    processed,
    completeWorkflow,
  }
}
