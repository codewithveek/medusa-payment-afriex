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
