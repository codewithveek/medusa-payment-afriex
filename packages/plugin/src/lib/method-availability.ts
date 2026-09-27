import { effectiveChannels } from "./checkout-channels"
import type { AfriexMethod } from "./constants"
import {
  currencyCoverage,
  DEPOSIT_RAILS,
  liveCheckoutChannels,
  railList,
  type DepositRail,
} from "./coverage"
import type { AfriexSettings } from "./settings"
import type { AfriexCheckoutChannel, AfriexProviderOptions } from "./types"

/**
 * Whether a method can collect a currency, and if not, why — in words an admin
 * can act on. `why` says whose decision it was: Afriex's ("coming_soon",
 * "unsupported") or the store's own settings ("settings").
 */
export type MethodAvailability =
  | { available: true; channels: AfriexCheckoutChannel[]; why?: undefined; reason?: undefined }
  | {
      available: false
      channels: []
      why: "coming_soon" | "unsupported" | "settings"
      reason: string
    }

export type AvailabilityContext = {
  /** The provider's options, when they could be read. Their overrides win over the coverage table. */
  options?: AfriexProviderOptions
  /** The store's admin settings, for checkout's channel choice. */
  settings?: AfriexSettings
  /** The store offers its own bank transfer here, so checkout's may be hidden. */
  bankTransferHere?: boolean
}

export function methodAvailability(
  method: AfriexMethod,
  currency: string,
  context: AvailabilityContext = {}
): MethodAvailability {
  return method === "bank_transfer"
    ? bankTransferAvailability(currency, context.options)
    : checkoutAvailability(currency, context)
}

export function bankTransferAvailability(
  currency: string,
  options?: AfriexProviderOptions
): MethodAvailability {
  const code = currency.toUpperCase()
  const confirmed = (options?.bankTransfer?.currencies ?? []).map((c) => c.toUpperCase())
  const coverage = currencyCoverage(code)

  if (confirmed.includes(code) || coverage.rails.VIRTUAL_BANK_ACCOUNT === "live") {
    return { available: true, channels: ["VIRTUAL_BANK_ACCOUNT"] }
  }

  if (coverage.rails.VIRTUAL_BANK_ACCOUNT === "soon") {
    return {
      available: false,
      channels: [],
      why: "coming_soon",
      reason: `Afriex does not open ${code} virtual accounts yet; it lists them as coming soon.`,
    }
  }

  if (!coverage.known) {
    return { available: false, channels: [], why: "unsupported", reason: notListed(code) }
  }

  return {
    available: false,
    channels: [],
    why: "unsupported",
    reason:
      coverage.rails.MOBILE_MONEY === "live"
        ? `Afriex collects ${code} by mobile money, not by bank transfer. Afriex Checkout can offer it.`
        : `Afriex cannot collect ${code} payments.`,
  }
}

export function checkoutAvailability(
  currency: string,
  context: AvailabilityContext = {}
): MethodAvailability {
  const code = currency.toUpperCase()
  const checkout = context.options?.checkout
  const currencyChannels = checkout?.currencyChannels?.[code] ?? liveCheckoutChannels(code)

  const channels = effectiveChannels({
    configured: checkout?.channels,
    adminChoice: context.settings?.checkoutChannels,
    currencyChannels,
    hideBankChannel:
      context.settings?.hideBankChannelWhereBankTransfer === true && context.bankTransferHere === true,
  })

  if (channels.length) {
    return { available: true, channels }
  }

  if (currencyChannels.length) {
    const live = DEPOSIT_RAILS.filter((rail) => currencyChannels.includes(rail))
    return {
      available: false,
      channels: [],
      why: "settings",
      reason: `Nothing is left to offer in ${code}: Afriex collects it by ${railList(live)}, which the store's Afriex Checkout settings leave out.`,
    }
  }

  const coverage = currencyCoverage(code)
  const soon = DEPOSIT_RAILS.filter((rail) => coverage.rails[rail] === "soon")
  if (soon.length) {
    return {
      available: false,
      channels: [],
      why: "coming_soon",
      reason: `Afriex cannot collect ${code} yet; it lists ${railList(soon)} there as coming soon.`,
    }
  }

  return {
    available: false,
    channels: [],
    why: "unsupported",
    reason: coverage.known ? `Afriex cannot collect ${code} payments.` : notListed(code),
  }
}

/** The live rails for a currency, for wording. */
export function liveRails(currency: string): DepositRail[] {
  const { rails } = currencyCoverage(currency)
  return DEPOSIT_RAILS.filter((rail) => rails[rail] === "live")
}

function notListed(code: string): string {
  return `Afriex does not list ${code} among the currencies it collects.`
}
