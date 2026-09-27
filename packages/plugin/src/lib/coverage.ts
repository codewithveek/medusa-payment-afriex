import type { AfriexCheckoutChannel } from "./types"

/**
 * Where Afriex can collect money, copied from its published coverage
 * (docs.afriex.com → Supported Currencies & Payment Rails, "Deposit Rails"),
 * last checked 2026-09-27. Payout rails are left out: the plugin only collects.
 *
 * Only two rails collect for a store: a virtual bank account, and mobile
 * money. Cards are not on that page; Afriex's hosted page decides those by
 * itself, so the plugin never rules on cards.
 *
 * A currency listed here as "soon" is refused until Afriex says it is live —
 * or until the store says so in its options (`checkout.currencyChannels`,
 * `bankTransfer.currencies`), which win over this table.
 */
export type DepositRail = "VIRTUAL_BANK_ACCOUNT" | "MOBILE_MONEY"

export type RailStatus = "live" | "soon"

type CoverageRow = {
  countries: string[]
  currency: string
  deposit: Partial<Record<DepositRail, RailStatus>>
}

const VA = "VIRTUAL_BANK_ACCOUNT"
const MM = "MOBILE_MONEY"

const COVERAGE: CoverageRow[] = [
  // Africa
  { countries: ["BJ", "CI"], currency: "XOF", deposit: { [MM]: "live" } },
  { countries: ["BF"], currency: "XOF", deposit: { [MM]: "soon" } },
  { countries: ["GW", "ML", "SN", "TG"], currency: "XOF", deposit: {} },
  { countries: ["CM"], currency: "XAF", deposit: { [MM]: "live" } },
  { countries: ["CG", "GA"], currency: "XAF", deposit: { [MM]: "soon" } },
  { countries: ["CF"], currency: "XAF", deposit: {} },
  { countries: ["BW"], currency: "BWP", deposit: {} },
  { countries: ["CD"], currency: "CDF", deposit: {} },
  { countries: ["EG"], currency: "EGP", deposit: {} },
  { countries: ["ET"], currency: "ETB", deposit: { [MM]: "live" } },
  { countries: ["GM"], currency: "GMD", deposit: {} },
  { countries: ["GH"], currency: "GHS", deposit: { [MM]: "soon", [VA]: "soon" } },
  { countries: ["GN"], currency: "GNF", deposit: {} },
  { countries: ["KE"], currency: "KES", deposit: { [MM]: "live", [VA]: "live" } },
  { countries: ["MG"], currency: "MGA", deposit: {} },
  { countries: ["MW"], currency: "MWK", deposit: { [MM]: "soon" } },
  { countries: ["MA"], currency: "MAD", deposit: {} },
  { countries: ["MZ"], currency: "MZN", deposit: { [MM]: "soon" } },
  { countries: ["NG"], currency: "NGN", deposit: { [VA]: "live" } },
  { countries: ["RW"], currency: "RWF", deposit: { [MM]: "soon" } },
  { countries: ["SL"], currency: "SLE", deposit: { [MM]: "soon" } },
  { countries: ["ZA"], currency: "ZAR", deposit: {} },
  { countries: ["SS"], currency: "SSP", deposit: {} },
  { countries: ["TZ"], currency: "TZS", deposit: { [MM]: "live" } },
  { countries: ["UG"], currency: "UGX", deposit: { [MM]: "live" } },
  { countries: ["ZM"], currency: "ZMW", deposit: { [MM]: "soon" } },
  // Americas. Canada's Interac is not a rail a store can collect on.
  { countries: ["CA"], currency: "CAD", deposit: {} },
  { countries: ["US"], currency: "USD", deposit: { [VA]: "live" } },
  // Europe
  {
    countries: [
      "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
      "IT", "LV", "LT", "LU", "MT", "NL", "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "UA",
    ],
    currency: "EUR",
    deposit: { [VA]: "soon" },
  },
  { countries: ["GB"], currency: "GBP", deposit: { [VA]: "soon" } },
  // Asia
  { countries: ["CN"], currency: "CNY", deposit: {} },
  { countries: ["IN"], currency: "INR", deposit: {} },
  { countries: ["PK"], currency: "PKR", deposit: {} },
]

export const DEPOSIT_RAILS: readonly DepositRail[] = [VA, MM]

export type CurrencyCoverage = {
  /** Whether Afriex lists the currency at all. */
  known: boolean
  /** Each rail's best status across the currency's countries; absent when no country has it. */
  rails: Partial<Record<DepositRail, RailStatus>>
  /** Every country Afriex lists with this currency. */
  countries: string[]
  /**
   * The one country to assume for the currency when nothing else says: the
   * only country that uses it, or the only one where a rail is live. Undefined
   * when it would be a guess (XOF, EUR).
   */
  homeCountry?: string
}

const better = (a: RailStatus | undefined, b: RailStatus | undefined): RailStatus | undefined =>
  a === "live" || b === "live" ? "live" : a ?? b

export function currencyCoverage(currency: string): CurrencyCoverage {
  const code = currency.toUpperCase()
  const rows = COVERAGE.filter((row) => row.currency === code)

  const rails: Partial<Record<DepositRail, RailStatus>> = {}
  const countries: string[] = []
  const liveCountries: string[] = []

  for (const row of rows) {
    countries.push(...row.countries)
    for (const rail of DEPOSIT_RAILS) {
      const status = better(rails[rail], row.deposit[rail])
      if (status) {
        rails[rail] = status
      }
    }
    if (Object.values(row.deposit).includes("live")) {
      liveCountries.push(...row.countries)
    }
  }

  return {
    known: rows.length > 0,
    rails,
    countries,
    homeCountry:
      countries.length === 1 ? countries[0] : liveCountries.length === 1 ? liveCountries[0] : undefined,
  }
}

/**
 * What Afriex's hosted page can collect a currency on today, in the shape
 * `effectiveChannels` takes. Cards ride along whenever anything is live,
 * because Afriex decides cards itself and drops them where it cannot.
 */
export function liveCheckoutChannels(currency: string): AfriexCheckoutChannel[] {
  const { rails } = currencyCoverage(currency)
  const live = DEPOSIT_RAILS.filter((rail) => rails[rail] === "live")
  return live.length ? [...live, "CARD"] : []
}

export const RAIL_LABEL: Record<DepositRail, string> = {
  [VA]: "bank transfer",
  [MM]: "mobile money",
}

/** "bank transfer and mobile money", for a sentence. */
export function railList(rails: DepositRail[]): string {
  return rails.map((rail) => RAIL_LABEL[rail]).join(" and ")
}
