import { describe, expect, it } from "vitest"
import {
  majorToMinorUnits,
  minorUnitExponent,
  toAfriexMinorUnits,
} from "../src/lib/amounts"
import { effectiveChannels } from "../src/lib/checkout-channels"
import { buildCheckoutCustomer } from "../src/lib/checkout-customer"
import { countryFromE164, toE164 } from "../src/lib/phone"
import { buildRedirectUrl, returnUrlProblem } from "../src/lib/return-url"

describe("minor units", () => {
  it("uses two decimals only where the currency has two", () => {
    expect(minorUnitExponent("ngn", undefined)).toBe(2)
    expect(minorUnitExponent("KES", undefined)).toBe(2)
    expect(minorUnitExponent("XOF", undefined)).toBeUndefined()
    expect(minorUnitExponent("UGX", undefined)).toBeUndefined()
    expect(minorUnitExponent("KWD", undefined)).toBeUndefined()
    expect(minorUnitExponent("XOF", { XOF: 0 })).toBe(0)
  })

  it("rounds half up and reports what is actually charged", () => {
    expect(toAfriexMinorUnits(5000, 2)).toEqual({ minor: 500000, charged: "5000" })
    expect(toAfriexMinorUnits("25000.005", 2)).toEqual({ minor: 2500001, charged: "25000.01" })
    expect(toAfriexMinorUnits("25000.004", 2)).toEqual({ minor: 2500000, charged: "25000" })
    expect(toAfriexMinorUnits(5000, 0)).toEqual({ minor: 5000, charged: "5000" })
  })

  it("converts back exactly, without float error", () => {
    expect(majorToMinorUnits("0.29", 2)).toBe("29")
    expect(majorToMinorUnits("25000.00", 2)).toBe("2500000")
  })
})

describe("phone numbers", () => {
  it("turns local and international forms into E.164 for the number's own country", () => {
    expect(toE164("08012345678", "NG")).toBe("+2348012345678")
    expect(toE164("0801 234 5678", "ng")).toBe("+2348012345678")
    expect(toE164("2348012345678", "NG")).toBe("+2348012345678")
    expect(toE164("+2348012345678", undefined)).toBe("+2348012345678")
    expect(toE164("002348012345678", undefined)).toBe("+2348012345678")
    expect(toE164("0712345678", "KE")).toBe("+254712345678")
  })

  it("refuses what it cannot make valid rather than guessing", () => {
    expect(toE164("08012345678", undefined)).toBeUndefined()
    expect(toE164("08012345678", "ZZ")).toBeUndefined()
    expect(toE164("call me", "NG")).toBeUndefined()
    expect(toE164("+123", undefined)).toBeUndefined()
    expect(toE164("", "NG")).toBeUndefined()
  })

  it("reads the country back from a number", () => {
    expect(countryFromE164("+2348012345678")).toBe("NG")
    expect(countryFromE164("+254712345678")).toBe("KE")
    expect(countryFromE164("+14155550100")).toBe("US")
  })
})

describe("the return URL", () => {
  it("accepts HTTPS with the order id in the path, and nothing else", () => {
    expect(returnUrlProblem("https://shop.example.com/checkout/afriex/return/{order_id}")).toBeUndefined()
    expect(returnUrlProblem("https://shop.example.com/return")).toBeUndefined()
    expect(returnUrlProblem("http://shop.example.com/return")).toMatch(/https/)
    expect(returnUrlProblem("https://user:pw@shop.example.com/return")).toMatch(/credentials/)
    expect(returnUrlProblem("https://shop.example.com/return?o={order_id}")).toMatch(/path/)
    expect(returnUrlProblem("https://shop.example.com/{order_id}/{order_id}")).toMatch(/once/)
    expect(returnUrlProblem("not a url")).toMatch(/URL/)
  })

  it("puts the order id in the path", () => {
    expect(
      buildRedirectUrl({
        returnUrl: "https://shop.example.com/checkout/afriex/return/{order_id}",
        orderId: "order_01ABC",
      })
    ).toEqual({ url: "https://shop.example.com/checkout/afriex/return/order_01ABC" })
  })

  it("lets a storefront choose only an origin the store allows", () => {
    const base = {
      returnUrl: "https://shop.example.com/return",
      allowedReturnOrigins: ["https://m.shop.example.com"],
    }

    expect(buildRedirectUrl({ ...base, requested: "https://m.shop.example.com/back" })).toEqual({
      url: "https://m.shop.example.com/back",
    })
    expect(buildRedirectUrl({ ...base, requested: "https://evil.example/phish" })).toHaveProperty("refused")
    expect(buildRedirectUrl({ ...base, requested: "http://shop.example.com/back" })).toHaveProperty("refused")
    expect(buildRedirectUrl({ ...base, requested: "javascript:alert(1)" })).toHaveProperty("refused")
  })
})

describe("checkout channels", () => {
  it("never sends a channel the installed SDK refuses", () => {
    expect(effectiveChannels({ configured: ["CARD", "MOBILE_MONEY"] })).toEqual(["MOBILE_MONEY"])
    expect(effectiveChannels({})).toEqual(["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"])
  })

  it("narrows to the admin's choice and to what the currency is known to collect", () => {
    expect(effectiveChannels({ adminChoice: ["MOBILE_MONEY"] })).toEqual(["MOBILE_MONEY"])
    expect(effectiveChannels({ currencyChannels: ["VIRTUAL_BANK_ACCOUNT"] })).toEqual([
      "VIRTUAL_BANK_ACCOUNT",
    ])
    expect(effectiveChannels({ currencyChannels: ["CARD"] })).toEqual([])
  })
})

describe("the checkout customer", () => {
  it("takes the phone and its country from the same address", () => {
    const built = buildCheckoutCustomer(
      {
        email: "ada@example.com",
        billing_address: { first_name: "Ada", last_name: "Obi", country_code: "gh" },
        shipping_address: { phone: "08012345678", country_code: "ng" },
      },
      undefined
    )

    expect(built).toEqual({
      customer: { name: "Ada Obi", email: "ada@example.com", phone: "+2348012345678", countryCode: "NG" },
    })
  })

  it("reads the country from an international number that has none beside it", () => {
    const built = buildCheckoutCustomer(
      { email: "a@example.com", customer: { phone: "+254712345678" } },
      undefined
    )
    expect(built).toMatchObject({ customer: { phone: "+254712345678", countryCode: "KE" } })
  })

  it("falls back to the email for a name", () => {
    const built = buildCheckoutCustomer(
      { email: "ada@example.com", billing_address: { phone: "+2348012345678" } },
      undefined
    )
    expect(built).toMatchObject({ customer: { name: "ada" } })
  })

  it("says what is missing instead of sending something invented", () => {
    expect(buildCheckoutCustomer({ billing_address: { phone: "+2348012345678" } }, "NG")).toEqual({
      missing: "email",
    })
    expect(buildCheckoutCustomer({ email: "a@example.com" }, "NG")).toEqual({ missing: "phone" })
    expect(
      buildCheckoutCustomer(
        { email: "a@example.com", billing_address: { phone: "08012345678" } },
        undefined
      )
    ).toEqual({ missing: "phone" })
  })
})
