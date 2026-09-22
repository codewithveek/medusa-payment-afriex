import type { BigNumberInput } from "@medusajs/framework/types"
import { BigNumber, MathBN } from "@medusajs/framework/utils"

/**
 * Medusa's `BigNumber.toString()` pads to full precision
 * ("25000.000000000000000"), which is not what belongs in payment
 * instructions a customer reads or in a stored expectation that later gets
 * compared. This is the plain decimal form.
 */
export function toAmountString(amount: BigNumberInput): string {
  return String(new BigNumber(amount).numeric)
}

export function toAmountNumber(amount: BigNumberInput): number {
  return new BigNumber(amount).numeric
}

/**
 * ISO 4217 currencies whose minor unit is not a hundredth. Afriex's checkout
 * docs only say "smallest unit of the currency" and "Minimum value is 100 (one
 * major unit)", which reads as two decimals everywhere; for these currencies
 * that is a 100× guess either way. They are refused unless the store states
 * the exponent Afriex uses in `checkout.minorUnitExponents`.
 */
const NON_TWO_DECIMAL_CURRENCIES = new Set([
  // zero decimals
  "BIF", "CLP", "DJF", "GNF", "ISK", "JPY", "KMF", "KRW", "PYG", "RWF", "UGX",
  "UYI", "VND", "VUV", "XAF", "XOF", "XPF",
  // three decimals
  "BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND",
])

/** The number of decimals Afriex's minor units use for a currency, or undefined when unknown. */
export function minorUnitExponent(
  currency: string,
  configured: Record<string, number> | undefined
): number | undefined {
  const code = currency.toUpperCase()
  const explicit = configured?.[code]
  if (typeof explicit === "number") {
    return explicit
  }
  return NON_TWO_DECIMAL_CURRENCIES.has(code) ? undefined : 2
}

/**
 * Converts a Medusa amount (major units, possibly with sub-unit decimals from
 * tax maths) into the integer Afriex's checkout takes, rounding half up.
 * Returns the integer and the major-unit amount it actually represents, which
 * is what the shopper is charged and what a deposit is later checked against.
 */
export function toAfriexMinorUnits(
  amount: BigNumberInput,
  exponent: number
): { minor: number; charged: string } {
  const scale = MathBN.convert(10).pow(exponent)
  const minor = MathBN.mult(MathBN.convert(amount), scale).integerValue(4 /* ROUND_HALF_UP */)
  const charged = MathBN.div(minor, scale)

  return { minor: minor.toNumber(), charged: toAmountString(charged) }
}

/** Converts a major-unit amount Afriex reported back into minor units, exactly. */
export function majorToMinorUnits(amount: BigNumberInput | string, exponent: number): string {
  const scale = MathBN.convert(10).pow(exponent)
  return MathBN.mult(MathBN.convert(amount), scale).toFixed()
}

/**
 * Compared as decimals, never as strings or floats: the same amount reaches
 * this plugin formatted several different ways — "25000", "25000.00", a
 * BigNumber — and a string comparison would read those as three different
 * amounts. Anything that is not a finite number is unequal to everything,
 * so a missing or malformed amount can never pass as a match.
 */
export function amountsEqual(
  left: BigNumberInput | string | undefined | null,
  right: BigNumberInput | string | undefined | null
): boolean {
  if (left === undefined || left === null || right === undefined || right === null) {
    return false
  }

  try {
    const a = MathBN.convert(left)
    const b = MathBN.convert(right)
    return a.isFinite() && b.isFinite() && MathBN.eq(a, b)
  } catch {
    return false
  }
}
