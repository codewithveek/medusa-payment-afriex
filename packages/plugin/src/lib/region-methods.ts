import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { effectiveChannels } from "./checkout-channels"
import { afriexMethodOf, type AfriexMethod } from "./constants"
import { AfriexAdminError } from "./admin-error"
import { methodAvailability } from "./method-availability"
import { readProviderOptions } from "./provider-options"
import type { GraphQuery } from "./reconciliation"
import { readAfriexSettings } from "./settings"
import type { AfriexCheckoutChannel, AfriexCheckoutSessionData } from "./types"

/** One Afriex method, as a region offers it — or cannot. */
export type OfferedMethod = {
  provider_id: string
  method: AfriexMethod
  /** Turned on in this region. */
  enabled: boolean
  /** Afriex can collect the region's currency this way, under the store's settings. */
  available: boolean
  /** Why not, in an admin's words, when it cannot. */
  unavailable_reason: string | null
  /** Checkout: what Afriex's page would offer in this currency. Bank transfer: its one rail. */
  channels: AfriexCheckoutChannel[]
}

export type RegionMethod = OfferedMethod & {
  /**
   * Payments in this region the shopper has been given the means to make — an
   * account, or an open payment link — and has not made yet.
   */
  waiting: number
}

export type RegionOffer = {
  region_id: string
  currency_code: string | null
  methods: OfferedMethod[]
}

/** Statuses of a session that has not been paid, cancelled or failed. */
const UNPAID_STATUSES = ["pending", "pending_authorization"]
const TERMINAL_AFRIEX_STATUSES = ["FAILED", "REJECTED", "CANCELLED"]
const WAITING_COUNT_LIMIT = 1000

export type WaitingSession = {
  id: string
  status: string
  payment_collection_id?: string | null
  data?: Record<string, unknown> | null
}

/**
 * Which Afriex methods a region offers, and which of those Afriex can actually
 * collect in the region's currency. The region's link to the payment provider
 * is the only on/off switch — the same one Medusa's own region settings edit,
 * and the one Medusa enforces when listing, starting and completing payments.
 * Whether the currency can be collected is Afriex's coverage, under the
 * store's own settings.
 */
export async function describeRegionMethods(
  container: MedusaContainer,
  regionId: string
): Promise<RegionOffer> {
  const region = await regionLink(container, regionId)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const providers = await paymentModule.listPaymentProviders({}, { select: ["id"] })

  const options = readProviderOptions(container)
  const settings = await readAfriexSettings(container)
  const bankTransferHere = region.providers.some(
    (id) => afriexMethodOf(id) === "bank_transfer"
  )

  const methods: OfferedMethod[] = []
  for (const provider of providers) {
    const method = afriexMethodOf(provider.id)
    if (!method) {
      continue
    }

    // A region always has a currency; only a test double lacks one. Nothing is
    // claimed then.
    const availability = region.currency
      ? methodAvailability(method, region.currency, { options, settings, bankTransferHere })
      : {
          available: true as const,
          channels:
            method === "bank_transfer"
              ? (["VIRTUAL_BANK_ACCOUNT"] as AfriexCheckoutChannel[])
              : effectiveChannels({
                  configured: options?.checkout?.channels,
                  adminChoice: settings.checkoutChannels,
                }),
        }

    methods.push({
      provider_id: provider.id,
      method,
      enabled: region.providers.includes(provider.id),
      available: availability.available,
      unavailable_reason: availability.available ? null : availability.reason,
      channels: availability.channels,
    })
  }

  return { region_id: regionId, currency_code: region.currency ?? null, methods }
}

/** `describeRegionMethods`, plus what is still waiting for money on each method here. */
export async function getRegionMethods(
  container: MedusaContainer,
  regionId: string
): Promise<{ region_id: string; currency_code: string | null; methods: RegionMethod[] }> {
  const offer = await describeRegionMethods(container, regionId)
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const now = Date.now()

  const candidates: { offered: OfferedMethod; sessions: WaitingSession[] }[] = []
  for (const offered of offer.methods) {
    // The payment module cannot filter sessions by status, so the most recent
    // ones are read and counted here.
    const recent = (await paymentModule.listPaymentSessions(
      { provider_id: offered.provider_id },
      {
        select: ["id", "status", "payment_collection_id", "data"],
        take: WAITING_COUNT_LIMIT,
        order: { created_at: "DESC" },
      }
    )) as unknown as WaitingSession[]

    candidates.push({
      offered,
      sessions: recent.filter((session) => mayStillReceiveMoney(offered.method, session, now)),
    })
  }

  const inRegion = await collectionsInRegion(
    container,
    regionId,
    candidates.flatMap(({ sessions }) =>
      sessions.map((session) => session.payment_collection_id).filter((id): id is string => !!id)
    )
  )

  return {
    region_id: regionId,
    currency_code: offer.currency_code,
    methods: candidates.map(({ offered, sessions }) => ({
      ...offered,
      waiting: sessions.filter((session) => inRegion.has(session.payment_collection_id ?? ""))
        .length,
    })),
  }
}

/**
 * Whether money can still arrive through this session, so turning its method
 * off leaves a payment in progress. A bank-transfer session always has an
 * account. A checkout session only does once its payment link is open: one
 * that was only chosen has no link, and its shopper will be asked to choose
 * again.
 */
export function mayStillReceiveMoney(
  method: AfriexMethod,
  session: WaitingSession,
  now: number
): boolean {
  if (!UNPAID_STATUSES.includes(session.status)) {
    return false
  }
  if (method === "bank_transfer") {
    return true
  }

  const data = (session.data ?? {}) as Partial<AfriexCheckoutSessionData>
  if (data.stage !== "open") {
    return false
  }

  const expiry = Date.parse(data.expiresAt ?? data.expiresAtEstimate ?? "")
  const moving =
    !!data.afriexTransactionId && !TERMINAL_AFRIEX_STATUSES.includes(String(data.currentStatus))
  return now < expiry || moving
}

/** Which of these payment collections belong to a cart or order in the region. */
async function collectionsInRegion(
  container: MedusaContainer,
  regionId: string,
  collectionIds: string[]
): Promise<Set<string>> {
  const inRegion = new Set<string>()
  if (!collectionIds.length) {
    return inRegion
  }

  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const ids = [...new Set(collectionIds)]

  // A collection made at checkout is linked to its cart, and to the order once
  // it is placed; one made by an order edit only to the order.
  for (const [linkEntity, ownerKey, ownerEntity] of [
    ["cart_payment_collection", "cart_id", "cart"],
    ["order_payment_collection", "order_id", "order"],
  ] as const) {
    const links = (
      (
        await query.graph({
          entity: linkEntity,
          fields: [ownerKey, "payment_collection_id"],
          filters: { payment_collection_id: ids },
        })
      ).data as Record<string, string | undefined>[]
    ).flatMap((link) => {
      const ownerId = link[ownerKey]
      const collectionId = link.payment_collection_id
      return ownerId && collectionId ? [{ ownerId, collectionId }] : []
    })
    if (!links.length) {
      continue
    }

    const owners = (
      await query.graph({
        entity: ownerEntity,
        fields: ["id", "region_id"],
        filters: { id: links.map((link) => link.ownerId) },
      })
    ).data as { id: string; region_id?: string | null }[]

    const ownersInRegion = new Set(
      owners.filter((owner) => owner.region_id === regionId).map((owner) => owner.id)
    )
    for (const link of links) {
      if (ownersInRegion.has(link.ownerId)) {
        inRegion.add(link.collectionId)
      }
    }
  }

  return inRegion
}

/**
 * Turns one Afriex method on or off in a region. Every other provider on the
 * region is kept: Medusa's region update takes the complete list, so it is
 * read, changed by one entry, and written back.
 *
 * Turning a method off only stops new payments. Orders already waiting for
 * money through it are still marked paid when the money arrives.
 */
export async function setRegionMethod(
  container: MedusaContainer,
  input: { regionId: string; providerId: string; enabled: boolean; confirmEmpty?: boolean }
): Promise<{ region_id: string; currency_code: string | null; methods: RegionMethod[] }> {
  if (!afriexMethodOf(input.providerId)) {
    throw new AfriexAdminError(
      "AFRIEX_NOT_AN_AFRIEX_PROVIDER",
      400,
      `${input.providerId} is not an Afriex payment provider.`
    )
  }

  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const [registered] = await paymentModule.listPaymentProviders(
    { id: input.providerId },
    { select: ["id"] }
  )
  if (!registered) {
    throw new AfriexAdminError(
      "AFRIEX_PROVIDER_NOT_REGISTERED",
      404,
      `${input.providerId} is not registered. Check the provider in medusa-config.ts.`
    )
  }

  const linked = (await regionLink(container, input.regionId)).providers
  const next = input.enabled
    ? [...new Set([...linked, input.providerId])]
    : linked.filter((id) => id !== input.providerId)

  if (!next.length && !input.confirmEmpty) {
    throw new AfriexAdminError(
      "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS",
      409,
      "This would leave the region with no payment method. Confirm to do it anyway."
    )
  }

  if (next.length !== linked.length) {
    await updateRegionsWorkflow(container).run({
      input: { selector: { id: input.regionId }, update: { payment_providers: next } },
    })
  }

  return getRegionMethods(container, input.regionId)
}

/** The region's currency and every payment provider it links to. */
async function regionLink(
  container: MedusaContainer,
  regionId: string
): Promise<{ providers: string[]; currency: string | undefined }> {
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const [region] = (
    await query.graph({
      entity: "region",
      fields: ["id", "currency_code", "payment_providers.id"],
      filters: { id: regionId },
    })
  ).data as { id: string; currency_code?: string | null; payment_providers?: { id: string }[] }[]

  if (!region) {
    throw new AfriexAdminError("AFRIEX_REGION_NOT_FOUND", 404, `No region ${regionId}.`)
  }

  return {
    providers: (region.payment_providers ?? []).map((provider) => provider.id),
    currency: region.currency_code?.toUpperCase() || undefined,
  }
}
