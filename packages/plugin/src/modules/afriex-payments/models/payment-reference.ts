import { model } from "@medusajs/framework/utils"

/**
 * Every reference the plugin hands out — the Medusa payment session id Afriex
 * echoes on a deposit — with the payment collection it belongs to. Medusa
 * deletes payment sessions outright when a cart changes or another method is
 * chosen, and an account or link given to the shopper can still be paid after
 * that. This is what lets such a payment be traced back to its order instead
 * of being dropped.
 */
export const PaymentReference = model.define("afriex_payment_reference", {
  id: model.id({ prefix: "afxref" }).primaryKey(),
  reference: model.text().unique(),
  method: model.enum(["bank_transfer", "checkout"]),
  payment_session_id: model.text(),
  payment_collection_id: model.text().nullable(),
  /** The amount the shopper was asked to pay, in major units. */
  amount: model.text(),
  currency_code: model.text(),
  /** Bank transfer: the virtual account's payment method id. */
  account_id: model.text().nullable(),
  /** Checkout: the amount sent to Afriex, in minor units. */
  amount_minor: model.text().nullable(),
  /** Checkout: Afriex's own id for the hosted session, from `CHECKOUT_SESSION.CREATED`. */
  afriex_session_id: model.text().nullable(),
  /** Checkout: when the payment link stops accepting payment, as Afriex reported it. */
  expires_at: model.dateTime().nullable(),
  /** When Medusa deleted or cancelled the session this reference was handed out for. */
  superseded_at: model.dateTime().nullable(),
  /**
   * Settled payments that arrived for this reference after its session was
   * gone. Each is `{ transaction_id, amount, currency, received_at, status }`,
   * where status is `held` until an admin applies or refunds it.
   */
  late_payments: model.json().nullable(),
})
