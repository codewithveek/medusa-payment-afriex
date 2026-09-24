import { money, post, type ApiResult } from "./api"

/** The shape of `usePrompt()`'s function, which both screens pass in. */
export type Prompt = (props: {
  title: string
  description: string
  confirmText?: string
  cancelText?: string
  variant?: "danger" | "confirmation"
}) => Promise<boolean>

export type LatePayment = {
  reference: string
  transaction_id: string
  amount: string
  currency?: string | null
}

/**
 * Applies a held late payment to its order, asking the person at each point
 * the server needs a decision instead of failing with an error toast:
 *
 * - the amount does not match what the order asks for (`AFRIEX_AMOUNT_DIFFERS`)
 *   — they are shown both amounts and asked whether to accept it in full;
 * - the order has no single unpaid Afriex payment to apply it to
 *   (`AFRIEX_NO_TARGET_SESSION`) — they are asked whether to replace the
 *   order's payment with one that holds it.
 *
 * Returns null when they cancel at any step.
 */
export async function applyLatePayment(
  prompt: Prompt,
  late: LatePayment
): Promise<ApiResult | null> {
  const path = `/admin/afriex/references/${late.reference}/apply`
  const body: Record<string, unknown> = { transaction_id: late.transaction_id }

  const first = await prompt({
    title: "Apply this payment to the order?",
    description: `${money(late.amount, late.currency)} arrived through an earlier payment that was replaced. It will be recorded on the order's current Afriex payment and captured.`,
    confirmText: "Apply it",
    cancelText: "Cancel",
    variant: "confirmation",
  })
  if (!first) {
    return null
  }

  // At most one question per kind of refusal, so this cannot loop.
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await post(path, body)
    const code = result.body?.code

    if (result.status === 409 && code === "AFRIEX_AMOUNT_DIFFERS" && !body.confirm_amount) {
      const received = money(result.body.received ?? late.amount, late.currency)
      const expected = money(result.body.expected, late.currency)
      const short = Number(result.body.received) < Number(result.body.expected)

      const confirmed = await prompt({
        title: "It is not the amount the order asks for",
        description: short
          ? `${received} arrived, but this order asks for ${expected}. Applying it marks the order fully paid, so the difference is not collected.`
          : `${received} arrived, but this order asks for ${expected}. Applying it marks the order paid; refund the difference from your Afriex dashboard.`,
        confirmText: "Apply it anyway",
        cancelText: "Cancel",
        variant: "confirmation",
      })
      if (!confirmed) {
        return null
      }
      body.confirm_amount = true
      continue
    }

    if (result.status === 409 && code === "AFRIEX_NO_TARGET_SESSION" && !body.replace_session) {
      const confirmed = await prompt({
        title: "Replace the order's payment?",
        description:
          "This order has no unpaid Afriex payment to apply it to — the shopper may have switched to another method. Replacing it records this money as the order's payment.",
        confirmText: "Replace and apply",
        cancelText: "Cancel",
        variant: "danger",
      })
      if (!confirmed) {
        return null
      }
      body.replace_session = true
      continue
    }

    return result
  }

  return null
}

/**
 * What accepting a held payment will actually do, in plain words — above all
 * that accepting a short payment marks the order fully paid.
 */
export function describeAccept(
  received: string | null | undefined,
  expected: string | null | undefined,
  currency: string | null | undefined
): string {
  const got = Number(received)
  const want = Number(expected)

  if (Number.isFinite(got) && Number.isFinite(want) && got < want) {
    return `Only ${money(received, currency)} of ${money(expected, currency)} arrived. Accepting marks this order fully paid, so the ${money(want - got, currency)} difference is not collected.`
  }

  if (Number.isFinite(got) && Number.isFinite(want) && got > want) {
    return `${money(received, currency)} arrived for an order of ${money(expected, currency)}. Accepting marks the order paid, and the ${money(got - want, currency)} extra is listed as money to refund.`
  }

  return `${money(received, currency)} arrived. Accepting marks the order paid.`
}
