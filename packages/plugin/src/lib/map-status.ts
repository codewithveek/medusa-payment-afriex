import type { PaymentSessionStatus } from "@medusajs/framework/types"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_SETTLED_AFTER_CANCEL,
  type AfriexMethod,
} from "./constants"

/**
 * Afriex's transaction status vocabulary → Medusa's payment session status.
 *
 * Every status `TransactionWebhookStatus` can carry is listed explicitly. The
 * fallthrough is `pending`, which is the only safe default: a status this
 * plugin has not been taught about must never confirm an order or declare it
 * failed, and `pending` does neither.
 *
 * Anything needing a human — Afriex reviewing the transaction, a dispute, a
 * deposit whose amount did not match — maps to `requires_more`, which is how
 * Medusa marks a session that cannot proceed on its own.
 */
export function mapAfriexStatus(
  afriexStatus: string | null | undefined,
  method: AfriexMethod
): PaymentSessionStatus {
  // On the hosted checkout page, mobile money waits here while the shopper
  // approves the prompt or enters the code on Afriex's page. That is a normal
  // step of paying, not something a person has to review.
  if (method === "checkout" && afriexStatus === "CUSTOMER_ACTION_REQUIRED") {
    return "pending"
  }

  return mapAfriexStatusToMedusaStatus(afriexStatus)
}

/** The bank-transfer mapping, which is also the default for every method. */
export function mapAfriexStatusToMedusaStatus(
  afriexStatus: string | null | undefined
): PaymentSessionStatus {
  switch (afriexStatus) {
    case "PENDING":
    case "PROCESSING":
    case "RETRY":
    case "SCHEDULED":
      return "pending"

    case "SUCCESS":
      return "captured"

    case "FAILED":
    case "REJECTED":
      return "error"

    case "CANCELLED":
      return "canceled"

    // Afriex is holding the transaction, disputing it, or telling us it does
    // not know — none of these are an outcome the plugin can act on alone.
    case "IN_REVIEW":
    case "CUSTOMER_ACTION_REQUIRED":
    case "UNKNOWN":
    case "REFUNDED":
    case "DISPUTED":
    case "DISPUTE_EVIDENCE_SUBMITTED":
    case "DISPUTE_RESOLVED":
    case "DISPUTE_WON":
    case "DISPUTE_LOST":
    case AFRIEX_AMOUNT_MISMATCH:
    case AFRIEX_SETTLED_AFTER_CANCEL:
    case AFRIEX_COLLECTION_AMOUNT_CHANGED:
      return "requires_more"

    default:
      return "pending"
  }
}

/** True once Afriex reports the deposit as settled. */
export function isSettled(afriexStatus: string | undefined): boolean {
  return afriexStatus === "SUCCESS"
}

/** True once the transaction can no longer settle. */
export function isTerminalFailure(afriexStatus: string | undefined): boolean {
  return (
    afriexStatus === "FAILED" ||
    afriexStatus === "REJECTED" ||
    afriexStatus === "CANCELLED"
  )
}

/**
 * True for a recorded status that money has already moved behind. Once a
 * session reaches one of these, a later or out-of-order progress event must
 * not overwrite it: a PROCESSING that lands after SUCCESS would otherwise make
 * `authorizePayment` defer a deposit that has in fact settled.
 */
export function isFinalRecordedStatus(afriexStatus: string | undefined): boolean {
  return (
    afriexStatus === "SUCCESS" ||
    afriexStatus === AFRIEX_AMOUNT_MISMATCH ||
    afriexStatus === AFRIEX_SETTLED_AFTER_CANCEL ||
    afriexStatus === AFRIEX_COLLECTION_AMOUNT_CHANGED
  )
}
