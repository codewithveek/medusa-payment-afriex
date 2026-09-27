import { describe, expect, it } from "vitest"
import { currencyCoverage, liveCheckoutChannels } from "../src/lib/coverage"
import {
  bankTransferAvailability,
  checkoutAvailability,
  methodAvailability,
} from "../src/lib/method-availability"
import type { AfriexSettings } from "../src/lib/settings"

const settings = (patch: Partial<AfriexSettings> = {}): AfriexSettings => ({
  checkoutChannels: null,
  hideBankChannelWhereBankTransfer: false,
  pausedRegions: null,
  ...patch,
})

describe("where Afriex collects", () => {
  it("reads Afriex's coverage page the way an admin would", () => {
    expect(currencyCoverage("ngn")).toMatchObject({
      known: true,
      rails: { VIRTUAL_BANK_ACCOUNT: "live" },
      homeCountry: "NG",
    })
    expect(currencyCoverage("KES").rails).toEqual({ VIRTUAL_BANK_ACCOUNT: "live", MOBILE_MONEY: "live" })
    expect(currencyCoverage("GHS").rails).toEqual({ VIRTUAL_BANK_ACCOUNT: "soon", MOBILE_MONEY: "soon" })
    expect(currencyCoverage("ZAR")).toMatchObject({ known: true, rails: {} })
    expect(currencyCoverage("JPY")).toMatchObject({ known: false, rails: {}, countries: [] })
  })

  it("names a country for a currency only when that is not a guess", () => {
    expect(currencyCoverage("XAF").homeCountry).toBe("CM") // live in Cameroon alone
    expect(currencyCoverage("XOF").homeCountry).toBeUndefined() // live in Benin and Côte d'Ivoire
    expect(currencyCoverage("EUR").homeCountry).toBeUndefined()
    expect(currencyCoverage("GHS").homeCountry).toBe("GH") // one country, even before it is live
    expect(currencyCoverage("USD").homeCountry).toBe("US")
  })

  it("gives checkout the live rails, and leaves cards to Afriex", () => {
    expect(liveCheckoutChannels("KES")).toEqual(["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY", "CARD"])
    expect(liveCheckoutChannels("NGN")).toEqual(["VIRTUAL_BANK_ACCOUNT", "CARD"])
    expect(liveCheckoutChannels("UGX")).toEqual(["MOBILE_MONEY", "CARD"])
    expect(liveCheckoutChannels("GHS")).toEqual([])
    expect(liveCheckoutChannels("ZAR")).toEqual([])
  })
})

describe("whether a method can collect a currency", () => {
  it("says so plainly, and whose decision it was", () => {
    expect(bankTransferAvailability("NGN")).toEqual({ available: true, channels: ["VIRTUAL_BANK_ACCOUNT"] })
    expect(bankTransferAvailability("GHS")).toMatchObject({
      available: false,
      why: "coming_soon",
      reason: expect.stringMatching(/GHS virtual accounts yet.*coming soon/),
    })
    expect(bankTransferAvailability("UGX")).toMatchObject({
      why: "unsupported",
      reason: expect.stringMatching(/mobile money, not by bank transfer/),
    })
    expect(bankTransferAvailability("ZAR")).toMatchObject({
      why: "unsupported",
      reason: "Afriex cannot collect ZAR payments.",
    })
    expect(bankTransferAvailability("JPY")).toMatchObject({
      why: "unsupported",
      reason: expect.stringMatching(/does not list JPY/),
    })
    expect(methodAvailability("checkout", "GHS")).toMatchObject({ why: "coming_soon" })
  })

  it("lets the store's own word override the page", () => {
    expect(
      bankTransferAvailability("GHS", { bankTransfer: { currencies: ["ghs"] } } as never)
    ).toMatchObject({ available: true })
    expect(
      checkoutAvailability("GHS", {
        options: { checkout: { currencyChannels: { GHS: ["MOBILE_MONEY"] } } } as never,
      })
    ).toEqual({ available: true, channels: ["MOBILE_MONEY"] })
  })

  it("tells the store's settings apart from Afriex's coverage", () => {
    // NGN collects by bank transfer alone; an admin who kept mobile money only left nothing.
    const mobileOnly = settings({ checkoutChannels: ["MOBILE_MONEY"] })
    expect(checkoutAvailability("NGN", { settings: mobileOnly })).toMatchObject({
      why: "settings",
      reason: expect.stringMatching(/Nothing is left to offer in NGN.*bank transfer/),
    })
    expect(checkoutAvailability("KES", { settings: mobileOnly })).toEqual({
      available: true,
      channels: ["MOBILE_MONEY"],
    })

    // The bank option is hidden only where the currency has another way.
    const hide = settings({ hideBankChannelWhereBankTransfer: true })
    expect(checkoutAvailability("NGN", { settings: hide, bankTransferHere: true }).channels).toEqual([
      "VIRTUAL_BANK_ACCOUNT",
    ])
    expect(checkoutAvailability("KES", { settings: hide, bankTransferHere: true }).channels).toEqual([
      "MOBILE_MONEY",
    ])
  })
})
