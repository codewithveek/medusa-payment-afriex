import type {
  AfriexCollectionAccount,
  AfriexPaymentInstructions,
} from "./types"

/**
 * Plain data, not markup — the storefront theme renders it however fits its own
 * design. The plugin only guarantees the shape.
 */
export function buildPaymentInstructions(
  account: AfriexCollectionAccount
): AfriexPaymentInstructions {
  const minutes = account.expiresInMinutes
  const hasExpiry = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0

  return {
    bankName: account.institutionName,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
    note: "This account is reserved for your order only. No reference needed.",
    expiresNote: hasExpiry
      ? `This account expires in ${minutes} minutes — please complete your transfer before then.`
      : "This account expires shortly — please complete your transfer promptly.",
    ...(hasExpiry ? { expiresInMinutes: minutes } : {}),
  }
}
