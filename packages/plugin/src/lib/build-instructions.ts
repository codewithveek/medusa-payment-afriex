import type {
  AfriexCollectionAccount,
  AfriexCollectionMethod,
  AfriexPaymentInstructions,
} from "./types"

/**
 * Plain data, not markup — the storefront theme renders it however fits its own
 * design. The plugin only guarantees the shape.
 */
export function buildPaymentInstructions(
  account: AfriexCollectionAccount,
  collectionMethod: AfriexCollectionMethod
): AfriexPaymentInstructions {
  const base = {
    bankName: account.institutionName,
    accountNumber: account.accountNumber,
    accountName: account.accountName,
  }

  if (collectionMethod === "pool") {
    return {
      ...base,
      reference: account.reference,
      note: "Include the reference exactly as shown when making your transfer.",
    }
  }

  const minutes = account.expiresInMinutes
  const hasExpiry = typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0

  return {
    ...base,
    note: "This account is reserved for your order only. No reference needed.",
    expiresNote: hasExpiry
      ? `This account expires in ${minutes} minutes — please complete your transfer before then.`
      : "This account expires shortly — please complete your transfer promptly.",
    ...(hasExpiry ? { expiresInMinutes: minutes } : {}),
  }
}
