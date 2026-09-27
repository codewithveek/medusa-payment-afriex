import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_METHODS,
  AFRIEX_SETTLED_AFTER_CANCEL,
  AFRIEX_WEBHOOK_PATH,
  afriexMethodOf,
  type AfriexMethod,
} from "./constants"
import { AFRIEX_WEBHOOK_MODULE } from "../modules/afriex-webhook"
import { AFRIEX_PAYMENTS_MODULE } from "../modules/afriex-payments"
import { methodAvailability } from "./method-availability"
import { readProviderOptions } from "./provider-options"
import type { GraphQuery } from "./reconciliation"
import { readAfriexSettings, type AfriexSettings } from "./settings"
import { mayStillReceiveMoney, type WaitingSession } from "./region-methods"
import type { LatePayment } from "./ledger"
import type { AfriexProviderOptions, AfriexSessionBase } from "./types"

const SCAN_LIMIT = 1000
const HELD_STATUSES = [
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_SETTLED_AFTER_CANCEL,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
]

export type SetupCheck = {
  id: string
  level: "ok" | "warn" | "advice"
  message: string
}

export type OverviewRegion = {
  id: string
  name: string
  currency_code: string
  /** Provider ids of the Afriex methods this region offers. */
  methods: string[]
  /** Per Afriex provider id: whether it can collect this region's currency, and why not. */
  availability: Record<string, { available: boolean; reason: string | null }>
}

export type OverviewMethod = {
  provider_id: string
  method: AfriexMethod
  regions_on: string[]
  /** Payments the shopper can still make: an account, or an open link. */
  waiting: number
  /** Checkout only: orders that chose it but never opened a link. */
  waiting_without_link: number
}

export type AttentionItem =
  | {
      kind: "session"
      payment_session_id: string
      order_id: string | null
      display_id: number | null
      status: string
      expected: string | null
      received: string | null
      currency: string | null
      /** Money beyond the payment, which needs refunding whatever else happens. */
      extra_deposits: number
    }
  | {
      kind: "late_payment"
      reference: string
      transaction_id: string
      amount: string
      currency: string | null
      payment_collection_id: string | null
      order_id: string | null
      display_id: number | null
    }

export type AfriexOverview = {
  webhook_path: string
  last_webhook: { at: string; event_id: string } | null
  setup: SetupCheck[]
  regions: OverviewRegion[]
  methods: OverviewMethod[]
  settings: AfriexSettings
  attention: AttentionItem[]
}

/**
 * Everything the Settings page shows, in one call: what is set up, which
 * methods are on where, what is still waiting for money, and what needs a
 * person. Each part fails softly — a store missing a table still gets a page
 * that tells it so.
 */
export async function getAfriexOverview(container: MedusaContainer): Promise<AfriexOverview> {
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)

  const regions = (
    await query.graph({
      entity: "region",
      fields: ["id", "name", "currency_code", "payment_providers.id"],
    })
  ).data as { id: string; name: string; currency_code: string; payment_providers?: { id: string }[] }[]

  // Bank transfer first, then checkout, whatever order the module lists them in.
  const registered = (await paymentModule.listPaymentProviders({}, { select: ["id"] }))
    .map((provider) => provider.id)
    .filter((id) => afriexMethodOf(id))
    .sort(
      (a, b) =>
        AFRIEX_METHODS.indexOf(afriexMethodOf(a)!) - AFRIEX_METHODS.indexOf(afriexMethodOf(b)!)
    )

  const options = readProviderOptions(container)
  const settings = await readAfriexSettings(container)

  const overviewRegions: OverviewRegion[] = regions.map((region) => {
    const methods = (region.payment_providers ?? [])
      .map((provider) => provider.id)
      .filter((id) => afriexMethodOf(id))
    const bankTransferHere = methods.some((id) => afriexMethodOf(id) === "bank_transfer")

    return {
      id: region.id,
      name: region.name,
      currency_code: region.currency_code,
      methods,
      availability: Object.fromEntries(
        registered.map((providerId) => {
          const result = methodAvailability(afriexMethodOf(providerId)!, region.currency_code, {
            options,
            settings,
            bankTransferHere,
          })
          return [
            providerId,
            { available: result.available, reason: result.available ? null : result.reason },
          ]
        })
      ),
    }
  })

  const now = Date.now()
  const methods: OverviewMethod[] = []
  const attention: AttentionItem[] = []
  const collectionIds = new Set<string>()

  for (const providerId of registered) {
    const method = afriexMethodOf(providerId)!
    const sessions = (await paymentModule.listPaymentSessions(
      { provider_id: providerId },
      {
        select: ["id", "status", "payment_collection_id", "data"],
        take: SCAN_LIMIT,
        order: { created_at: "DESC" },
      }
    )) as unknown as WaitingSession[]

    let waiting = 0
    let waitingWithoutLink = 0

    for (const session of sessions) {
      if (mayStillReceiveMoney(method, session, now)) {
        waiting++
      } else if (
        method === "checkout" &&
        ["pending", "pending_authorization"].includes(session.status) &&
        (session.data as { stage?: string } | null)?.stage === "selected"
      ) {
        waitingWithoutLink++
      }

      const data = (session.data ?? {}) as Partial<AfriexSessionBase>
      const extraDeposits = data.extraDeposits?.length ?? 0
      if (HELD_STATUSES.includes(String(data.currentStatus)) || extraDeposits) {
        attention.push({
          kind: "session",
          payment_session_id: session.id,
          order_id: null,
          display_id: null,
          status: String(data.currentStatus ?? "UNKNOWN"),
          expected: data.expectedAmount ?? null,
          received: data.receivedAmount ?? null,
          currency: data.receivedCurrency ?? data.expectedCurrency ?? null,
          extra_deposits: extraDeposits,
        })
        if (session.payment_collection_id) {
          collectionIds.add(session.payment_collection_id)
        }
      }
    }

    methods.push({
      provider_id: providerId,
      method,
      regions_on: overviewRegions
        .filter((region) => region.methods.includes(providerId))
        .map((region) => region.id),
      waiting,
      waiting_without_link: waitingWithoutLink,
    })
  }

  for (const held of await heldLatePayments(container)) {
    attention.push(held)
    if (held.payment_collection_id) {
      collectionIds.add(held.payment_collection_id)
    }
  }

  await nameTheOrders(container, query, paymentModule, attention, collectionIds)

  return {
    webhook_path: AFRIEX_WEBHOOK_PATH,
    last_webhook: await lastWebhook(container),
    setup: await setupChecks(container, registered, overviewRegions, options),
    regions: overviewRegions,
    methods,
    settings,
    attention,
  }
}

/** Late payments the plugin could not apply on its own, still waiting for a person. */
async function heldLatePayments(
  container: MedusaContainer
): Promise<Extract<AttentionItem, { kind: "late_payment" }>[]> {
  let rows: {
    reference: string
    payment_collection_id: string | null
    late_payments: LatePayment[] | null
  }[] = []

  try {
    rows = (await container
      .resolve<{ listPaymentReferences: Function }>(AFRIEX_PAYMENTS_MODULE)
      .listPaymentReferences({}, { take: SCAN_LIMIT, order: { created_at: "DESC" } })) as never
  } catch {
    return []
  }

  return rows.flatMap((row) =>
    (row.late_payments ?? [])
      .filter((payment) => payment.status === "held")
      .map((payment) => ({
        kind: "late_payment" as const,
        reference: row.reference,
        transaction_id: payment.transaction_id,
        amount: payment.amount,
        currency: payment.currency ?? null,
        payment_collection_id: row.payment_collection_id,
        order_id: null,
        display_id: null,
      }))
  )
}

/** Fills in which order each item belongs to, so the page can link to it. */
async function nameTheOrders(
  container: MedusaContainer,
  query: GraphQuery,
  paymentModule: IPaymentModuleService,
  attention: AttentionItem[],
  collectionIds: Set<string>
): Promise<void> {
  const sessionIds = attention
    .filter((item): item is Extract<AttentionItem, { kind: "session" }> => item.kind === "session")
    .map((item) => item.payment_session_id)

  const sessionCollections = new Map<string, string>()
  if (sessionIds.length) {
    const sessions = await paymentModule.listPaymentSessions(
      { id: sessionIds },
      { select: ["id", "payment_collection_id"] }
    )
    for (const session of sessions) {
      const collectionId = (session as { payment_collection_id?: string }).payment_collection_id
      if (collectionId) {
        sessionCollections.set(session.id, collectionId)
        collectionIds.add(collectionId)
      }
    }
  }

  if (!collectionIds.size) {
    return
  }

  const links = (
    await query.graph({
      entity: "order_payment_collection",
      fields: ["order_id", "payment_collection_id"],
      filters: { payment_collection_id: [...collectionIds] },
    })
  ).data as { order_id?: string; payment_collection_id?: string }[]

  const orderByCollection = new Map<string, string>()
  for (const link of links) {
    if (link.order_id && link.payment_collection_id) {
      orderByCollection.set(link.payment_collection_id, link.order_id)
    }
  }

  const orders = orderByCollection.size
    ? ((
        await query.graph({
          entity: "order",
          fields: ["id", "display_id"],
          filters: { id: [...new Set(orderByCollection.values())] },
        })
      ).data as { id: string; display_id?: number }[])
    : []
  const displayById = new Map(orders.map((order) => [order.id, order.display_id ?? null]))

  for (const item of attention) {
    const collectionId =
      item.kind === "session"
        ? sessionCollections.get(item.payment_session_id)
        : item.payment_collection_id ?? undefined
    const orderId = collectionId ? orderByCollection.get(collectionId) : undefined
    if (orderId) {
      item.order_id = orderId
      item.display_id = displayById.get(orderId) ?? null
    }
  }
}

async function lastWebhook(
  container: MedusaContainer
): Promise<{ at: string; event_id: string } | null> {
  try {
    const [row] = (await container
      .resolve<{ listProcessedWebhooks: Function }>(AFRIEX_WEBHOOK_MODULE)
      .listProcessedWebhooks({}, { take: 1, order: { processed_at: "DESC" } })) as {
      event_id: string
      processed_at: string | Date
    }[]

    return row
      ? { at: new Date(row.processed_at).toISOString(), event_id: row.event_id }
      : null
  } catch {
    return null
  }
}

/**
 * What a person can act on before a shopper hits it. Only things the plugin can
 * actually see are checked; everything else is stated as advice, not as a tick.
 */
async function setupChecks(
  container: MedusaContainer,
  registered: string[],
  regions: OverviewRegion[],
  options: AfriexProviderOptions | undefined
): Promise<SetupCheck[]> {
  const checks: SetupCheck[] = []

  for (const method of AFRIEX_METHODS) {
    const providerId = registered.find((id) => afriexMethodOf(id) === method)
    const label = method === "checkout" ? "Afriex Checkout" : "Bank transfer"

    if (!providerId) {
      checks.push({
        id: `${method}:registered`,
        level: "warn",
        message: `${label} is not registered. Add the Afriex provider to medusa-config.ts to offer it.`,
      })
      continue
    }

    const on = regions.filter((region) => region.methods.includes(providerId))
    checks.push(
      on.length
        ? {
            id: `${method}:regions`,
            level: "ok",
            message: `${label} is on in ${on.length} of ${regions.length} ${regions.length === 1 ? "region" : "regions"}.`,
          }
        : {
            id: `${method}:regions`,
            level: "warn",
            message: `${label} is registered but not on in any region, so no shopper is offered it.`,
          }
    )

    // On somewhere Afriex cannot collect: every shopper who picks it there is
    // refused, so it should be off, or the store's settings changed.
    for (const region of on) {
      const availability = region.availability[providerId]
      if (availability && !availability.available) {
        checks.push({
          id: `${method}:cannot_collect:${region.id}`,
          level: "warn",
          message: `${label} is on in ${region.name} (${region.currency_code.toUpperCase()}), but ${availability.reason} Shoppers there are refused it — turn it off in ${region.name}.`,
        })
      }
    }

    if (method === "bank_transfer" && on.length) {
      checks.push({
        id: "bank_transfer:approval",
        level: "advice",
        message:
          "Afriex approves each currency for your store before the first virtual account can be opened in it. If shoppers are told bank transfer \"isn't available yet\", that review is still running: the server log names the currency, and Afriex support can say where it stands.",
      })
    }
  }

  const returnUrl = checkoutReturnUrl(options)
  if (registered.some((id) => afriexMethodOf(id) === "checkout")) {
    checks.push(
      returnUrl === false
        ? {
            id: "checkout:return_url",
            level: "warn",
            message:
              "Afriex Checkout has no return URL (checkout.returnUrl in medusa-config.ts), so it refuses every payment.",
          }
        : {
            id: "checkout:return_url",
            level: "ok",
            message:
              typeof returnUrl === "string"
                ? `Shoppers come back to ${returnUrl}`
                : "Afriex Checkout is configured.",
          }
    )
  }

  const webhook = await lastWebhook(container)
  checks.push(
    webhook
      ? {
          id: "webhook:seen",
          level: "ok",
          message: `Last webhook from Afriex: ${new Date(webhook.at).toLocaleString()}.`,
        }
      : {
          id: "webhook:seen",
          level: "warn",
          message: `No webhook has ever arrived. Afriex must be able to reach ${AFRIEX_WEBHOOK_PATH} on this server, and that URL must be the one registered in the Afriex dashboard.`,
        }
  )

  checks.push({
    id: "locking",
    level: "advice",
    message:
      "Running more than one server instance? Configure a shared locking provider (Redis or Postgres). Medusa's default lock only works inside one process; a database constraint still prevents a double capture.",
  })

  return checks
}

/**
 * The configured return URL: `false` when checkout is registered without one,
 * a string when it is set, and `undefined` when the config could not be read
 * at all (in which case nothing is claimed).
 */
function checkoutReturnUrl(options: AfriexProviderOptions | undefined): string | false | undefined {
  if (!options) {
    return undefined
  }
  const url = options.checkout?.returnUrl
  return typeof url === "string" && url ? url : false
}
