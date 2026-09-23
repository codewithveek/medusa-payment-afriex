import { vi } from "vitest"
import type { TransactionWebhookPayload } from "@afriex/sdk"
import { MedusaError } from "@medusajs/framework/utils"

export const SESSION_ID = "payses_01HTEST"
export const PROVIDER_ID = "pp_afriex_afriex"
export const CHECKOUT_PROVIDER_ID = "pp_afriex-checkout_afriex"
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

/** What Afriex sends when a hosted checkout session is created, and again once it is paid. */
export function buildCheckoutSessionPayload(
  overrides: Record<string, unknown> = {}
): { event: "CHECKOUT_SESSION.CREATED"; data: Record<string, unknown> } {
  return {
    event: "CHECKOUT_SESSION.CREATED",
    data: {
      sessionId: "cs_afriex_1",
      merchantReference: SESSION_ID,
      amount: 2500000,
      currency: "NGN",
      expiresAt: "2026-09-16T10:30:00.000Z",
      createdAt: "2026-09-16T10:00:00.000Z",
      metadata: {},
      customer: {
        name: "Ada Obi",
        email: "shopper@example.com",
        phone: "+2348012345678",
        countryCode: "NG",
      },
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
    /** Status of the session's payment collection; "canceled" once its order is cancelled. */
    collectionStatus?: string
    /** The collection's current amount; differs from the session's after an admin order edit. */
    collectionAmount?: number
    /** Status of the order behind the collection. */
    orderStatus?: string
    /** The cart was completed into an order before the deposit arrived (the normal bank-transfer flow). */
    orderPlaced?: boolean
    /** Other sessions on the same payment collection. */
    siblingSessions?: { id: string; payment?: { id: string } }[]
    /**
     * Payment providers as the payment module lists them. Every Afriex one
     * verifies a valid signature, as a real registration sharing the business's
     * one webhook key would.
     */
    providers?: string[]
    /** False simulates servers that do not share a lock: every job runs at once. */
    sharedLock?: boolean
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
    collectionStatus = "awaiting",
    orderStatus = "pending",
    orderPlaced = false,
    siblingSessions = [],
    providers = ["pp_stripe_stripe", PROVIDER_ID],
    sharedLock = true,
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

  let orderExists = orderPlaced
  const order = { id: "order_1", status: orderStatus }

  const paymentModule = {
    retrievePaymentSession: vi.fn(async (id: string) => {
      if (sessionMissing || (id !== session.id && !siblingSessions.some((s) => s.id === id))) {
        // Medusa throws for an id it does not hold — which is what a reference
        // whose session was deleted looks like.
        throw new MedusaError(MedusaError.Types.NOT_FOUND, "Payment session not found")
      }
      return siblingSessions.find((s) => s.id === id) ?? session
    }),
    listPaymentSessions: vi.fn(async (filters: Record<string, unknown> = {}) => {
      if (sessionMissing) {
        return []
      }
      return filters.payment_collection_id ? [session, ...siblingSessions] : [session]
    }),
    listPaymentProviders: vi.fn(async () => providers.map((id) => ({ id }))),
    retrievePaymentCollection: vi.fn(async (id: string) => ({
      id,
      status: collectionStatus,
      amount: options.collectionAmount ?? sessionAmount,
    })),
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
      if (entity === "order_cart" || entity === "order_payment_collection") {
        return { data: orderExists ? [{ order_id: "order_1" }] : [] }
      }
      if (entity === "order") {
        return { data: orderExists ? [{ ...order }] : [] }
      }
      return { data: [] }
    }),
  }

  // Stands in for the plugin's own table: a Map keyed by event_id, with the
  // same unique-constraint behaviour the real column has.
  const processed = new Map<
    string,
    { id: string; event_id: string; processed_at: Date; completed_at: Date | null }
  >()

  const webhookModule = {
    createProcessedWebhooks: vi.fn(async ({ event_id, processed_at }: { event_id: string; processed_at: Date }) => {
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
      const record = {
        id: `pw_${processed.size + 1}_${event_id}`,
        event_id,
        processed_at,
        completed_at: null as Date | null,
      }
      processed.set(event_id, record)
      return record
    }),
    listProcessedWebhooks: vi.fn(async ({ event_id }: { event_id: string }) => {
      const found = processed.get(event_id)
      return found ? [found] : []
    }),
    updateProcessedWebhooks: vi.fn(async ({ id, completed_at }: { id: string; completed_at: Date }) => {
      for (const value of processed.values()) {
        if (value.id === id) {
          value.completed_at = completed_at
        }
      }
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

  // Serialises jobs per key the way Medusa's locking module does, so a test
  // that fires two deliveries at once sees the real interleaving.
  const lockTails = new Map<string, Promise<unknown>>()
  const locking = {
    execute: vi.fn(async <T>(keys: string | string[], job: () => Promise<T>) => {
      if (!sharedLock) {
        return job()
      }
      const key = ([] as string[]).concat(keys).join("|")
      const previous = lockTails.get(key) ?? Promise.resolve()
      const run = previous.catch(() => undefined).then(job)
      lockTails.set(key, run.catch(() => undefined))
      return run
    }),
  }

  const paymentsModule = createPaymentsStore()

  const registry: Record<string, unknown> = {
    payment: paymentModule,
    afriex_payments: paymentsModule,
    locking,
    afriex_webhook: webhookModule,
    logger,
    query,
  }

  return {
    resolve: vi.fn((key: string) => registry[key]),
    paymentModule,
    webhookModule,
    paymentsModule,
    locking,
    order,
    query,
    logger,
    session,
    processed,
    completeWorkflow,
  }
}

/**
 * Stands in for the plugin's `afriex_payments` module: the payment-reference
 * ledger and the settlement table, each with the unique constraint the real
 * table has, failing the way Medusa's generated service does.
 */
export function createPaymentsStore() {
  const references = new Map<string, Record<string, any>>()
  const settlements = new Map<string, Record<string, any>>()
  let seq = 0

  const uniqueViolation = (column: string, value: string) =>
    Object.assign(new Error(`Record with ${column}: ${value}, already exists.`), {
      type: "invalid_data",
    })

  const matches = (row: Record<string, any>, filters: Record<string, unknown>) =>
    Object.entries(filters).every(([key, value]) => row[key] === value)

  return {
    references,
    settlements,
    listPaymentReferences: vi.fn(async (filters: Record<string, unknown> = {}) =>
      [...references.values()].filter((row) => matches(row, filters)).map((row) => ({ ...row }))
    ),
    createPaymentReferences: vi.fn(async (values: Record<string, any>) => {
      if ([...references.values()].some((row) => row.reference === values.reference)) {
        throw uniqueViolation("reference", values.reference)
      }
      const row = { id: `afxref_${++seq}`, superseded_at: null, late_payments: null, ...values }
      references.set(row.id, row)
      return { ...row }
    }),
    updatePaymentReferences: vi.fn(async ({ id, ...values }: Record<string, any>) => {
      const row = references.get(id)
      if (row) {
        Object.assign(row, values)
      }
      return row ? { ...row } : undefined
    }),
    listSettlements: vi.fn(async (filters: Record<string, unknown> = {}) =>
      [...settlements.values()].filter((row) => matches(row, filters)).map((row) => ({ ...row }))
    ),
    createSettlements: vi.fn(async (values: Record<string, any>) => {
      if (
        [...settlements.values()].some(
          (row) => row.payment_collection_id === values.payment_collection_id
        )
      ) {
        throw uniqueViolation("payment_collection_id", values.payment_collection_id)
      }
      const row = { id: `afxset_${++seq}`, ...values }
      settlements.set(row.id, row)
      return { ...row }
    }),
  }
}
