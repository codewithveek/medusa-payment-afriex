/** The ways Afriex's hosted page can take a payment, as the plugin names them. */
export type AfriexChannel = "VIRTUAL_BANK_ACCOUNT" | "MOBILE_MONEY" | "CARD"

const LABEL: Record<AfriexChannel, string> = {
  VIRTUAL_BANK_ACCOUNT: "bank transfer",
  MOBILE_MONEY: "mobile money",
  CARD: "card",
}

/**
 * "bank transfer or mobile money": what Afriex's page will offer, as the
 * plugin reports it for the order's currency. Empty when nothing is known.
 */
export function describeChannels(channels: readonly AfriexChannel[] | null | undefined): string {
  const labels = (channels ?? []).map(
    (channel) => LABEL[channel] ?? channel.toLowerCase().replace(/_/g, " ")
  )
  if (labels.length <= 1) {
    return labels.join("")
  }
  return `${labels.slice(0, -1).join(", ")} or ${labels[labels.length - 1]}`
}

export function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
