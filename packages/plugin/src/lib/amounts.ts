import type { BigNumberInput } from "@medusajs/framework/types"
import { BigNumber } from "@medusajs/framework/utils"

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
 * Compared numerically, never as strings: the same amount reaches this plugin
 * formatted several different ways — "25000", "25000.00", a BigNumber — and a
 * string comparison would read those as three different amounts and refuse a
 * payment that is in fact exact.
 */
export function amountsEqual(
  left: BigNumberInput | string | undefined,
  right: BigNumberInput | string | undefined
): boolean {
  if (left === undefined || left === null || right === undefined || right === null) {
    return false
  }

  const a = Number(left)
  const b = Number(right)

  return Number.isFinite(a) && Number.isFinite(b) && a === b
}
