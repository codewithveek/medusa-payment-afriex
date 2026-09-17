export function formatAmount(amount: number, currencyCode: string): string {
  return new Intl.NumberFormat("en-NG", {
    style: "currency",
    currency: currencyCode.toUpperCase(),
  }).format(amount)
}
