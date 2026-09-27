import { MedusaError } from "@medusajs/framework/utils"

/**
 * Every refusal the checkout flow can give a storefront, with a stable code.
 * Storefronts branch on the code, never on the message.
 */
export const CheckoutErrorCode = {
  /** A payment is in flight on this order, or its link is still open. */
  PAYMENT_IN_PROGRESS: "AFRIEX_PAYMENT_IN_PROGRESS",
  /** The order is cancelled or already paid. */
  ORDER_NOT_PAYABLE: "AFRIEX_ORDER_NOT_PAYABLE",
  /** The method is not enabled in the order's region. */
  METHOD_UNAVAILABLE: "AFRIEX_METHOD_UNAVAILABLE",
  EMAIL_REQUIRED: "AFRIEX_CHECKOUT_EMAIL_REQUIRED",
  PHONE_REQUIRED: "AFRIEX_CHECKOUT_PHONE_REQUIRED",
  /**
   * The store cannot take checkout payments: `checkout.returnUrl` is not set in
   * medusa-config, or Afriex does not let the store's account create checkout
   * sessions.
   */
  NOT_CONFIGURED: "AFRIEX_CHECKOUT_NOT_CONFIGURED",
  RETURN_URL_NOT_ALLOWED: "AFRIEX_RETURN_URL_NOT_ALLOWED",
  /** The order's currency or amount cannot be collected through checkout. */
  UNAVAILABLE_FOR_CURRENCY: "AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY",
  /** Afriex refused the request for a reason the shopper may be able to fix. */
  REFUSED: "AFRIEX_CHECKOUT_REFUSED",
  /** Afriex could not be reached or failed; trying again may work. */
  TEMPORARILY_UNAVAILABLE: "AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE",
} as const

export type CheckoutErrorCode = (typeof CheckoutErrorCode)[keyof typeof CheckoutErrorCode]

/** The refusals bank transfer can give a storefront, before any account is opened. */
export const BankTransferErrorCode = {
  /** Afriex does not open virtual accounts in the order's currency. */
  UNAVAILABLE_FOR_CURRENCY: "AFRIEX_BANK_TRANSFER_UNAVAILABLE_FOR_CURRENCY",
  /** Afriex has not yet approved the store to collect this currency by virtual account. */
  AWAITING_APPROVAL: "AFRIEX_BANK_TRANSFER_AWAITING_APPROVAL",
} as const

export type BankTransferErrorCode = (typeof BankTransferErrorCode)[keyof typeof BankTransferErrorCode]

type RefusalCode = CheckoutErrorCode | BankTransferErrorCode

/** A refusal raised inside a provider, carrying its code through Medusa to the HTTP response. */
export function checkoutRefusal(code: RefusalCode, message: string): MedusaError {
  return new MedusaError(MedusaError.Types.NOT_ALLOWED, message, code)
}

export function checkoutFailure(code: RefusalCode, message: string): MedusaError {
  return new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message, code)
}
