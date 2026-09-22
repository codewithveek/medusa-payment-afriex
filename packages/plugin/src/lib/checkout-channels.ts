import type { AfriexCheckoutChannel } from "./types"

export const CHECKOUT_CHANNELS: readonly AfriexCheckoutChannel[] = [
  "VIRTUAL_BANK_ACCOUNT",
  "MOBILE_MONEY",
  "CARD",
]

/**
 * What the installed `@afriex/checkout` accepts. Its own list is private, so
 * the plugin keeps this copy, and a contract test fails the day the SDK starts
 * accepting more — so the cap is lifted on purpose, not by accident. The docs
 * list CARD as well; the SDK refuses it before sending the request.
 */
export const SDK_ACCEPTED_CHECKOUT_CHANNELS: readonly AfriexCheckoutChannel[] = [
  "VIRTUAL_BANK_ACCOUNT",
  "MOBILE_MONEY",
]

export function isCheckoutChannel(value: unknown): value is AfriexCheckoutChannel {
  return typeof value === "string" && (CHECKOUT_CHANNELS as readonly string[]).includes(value)
}

/**
 * The channels a checkout session asks Afriex for: the developer's upper
 * bound, cut down to what the SDK can send, to the admin's choice when there
 * is one, and to what the currency is known to collect when the developer
 * said. Afriex drops channels a currency cannot collect by itself, so an
 * unknown currency keeps the whole list.
 */
export function effectiveChannels(input: {
  configured?: readonly AfriexCheckoutChannel[]
  adminChoice?: readonly AfriexCheckoutChannel[] | null
  currencyChannels?: readonly AfriexCheckoutChannel[]
}): AfriexCheckoutChannel[] {
  const bound = input.configured?.length ? input.configured : CHECKOUT_CHANNELS

  return bound.filter(
    (channel) =>
      SDK_ACCEPTED_CHECKOUT_CHANNELS.includes(channel) &&
      (!input.adminChoice || input.adminChoice.includes(channel)) &&
      (!input.currencyChannels || input.currencyChannels.includes(channel))
  )
}
