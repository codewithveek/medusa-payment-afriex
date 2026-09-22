import { afriexMethodOf } from "./constants"
import type {
  AfriexBankTransferSessionData,
  AfriexCheckoutSessionData,
} from "./types"

export type ReadSessionData =
  | { method: "bank_transfer"; data: AfriexBankTransferSessionData }
  | { method: "checkout"; data: AfriexCheckoutSessionData }

/**
 * Reads a session's Afriex data as the shape its provider writes. The method
 * comes from the provider id, never from the data itself: part of the data is
 * whatever the storefront sent when it created the session. Sessions stored
 * before the method was recorded belong to bank transfer, the only method
 * there was.
 *
 * Returns undefined for a session that is not an Afriex one.
 */
export function readSessionData(
  providerId: string | null | undefined,
  data: unknown
): ReadSessionData | undefined {
  const method = afriexMethodOf(providerId)
  const record = (data && typeof data === "object" ? data : {}) as Record<string, unknown>

  if (method === "bank_transfer") {
    return {
      method,
      data: { ...record, method } as unknown as AfriexBankTransferSessionData,
    }
  }

  if (method === "checkout") {
    return {
      method,
      data: { ...record, method } as unknown as AfriexCheckoutSessionData,
    }
  }

  return undefined
}
