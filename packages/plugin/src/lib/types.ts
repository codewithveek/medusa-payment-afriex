export type AfriexCollectionMethod = "dedicated" | "pool"

export type AfriexProviderOptions = {
  apiKey: string
  environment: "staging" | "production"
  webhookPublicKey: string
  collectionMethod?: AfriexCollectionMethod
  /** Used when the cart has no billing address to infer the country from. */
  defaultCountryCode?: string
}

/**
 * Account details normalized away from whichever collection method produced
 * them, so everything downstream — instructions, session data, the admin
 * widget — works off one shape.
 */
export type AfriexCollectionAccount = {
  paymentMethodId: string
  /** Afriex customer the account was minted for; absent when it is business-owned. */
  customerId?: string
  accountNumber: string
  accountName?: string
  institutionName?: string
  /** What the customer must quote on the transfer, and what the webhook is matched against. */
  reference: string
  /** Minutes until a dynamic virtual account stops accepting deposits, when Afriex reports it. */
  expiresInMinutes?: number
}

export type AfriexPaymentInstructions = {
  bankName?: string
  accountNumber: string
  accountName?: string
  reference?: string
  note: string
  expiresNote?: string
  expiresInMinutes?: number
}

/**
 * A settled deposit other than the one that paid the session: a second
 * transfer after capture, or an earlier mismatched one that a later correct
 * transfer superseded. Each is money the merchant holds and must refund.
 */
export type AfriexExtraDeposit = {
  transactionId: string
  amount: string
  currency?: string
  receivedAt: string
}

/**
 * Everything the plugin persists on the Medusa payment session. `currentStatus`
 * is the only field the webhook handler mutates after initiation; the expected
 * amount/currency are written once and treated as immutable, since they are what
 * an incoming deposit gets checked against.
 */
export type AfriexSessionData = {
  afriexPaymentMethodId: string
  /** Afriex customer the collection account belongs to; absent for business-owned accounts. */
  afriexCustomerId?: string
  collectionMethod: AfriexCollectionMethod
  accountNumber: string
  accountName?: string
  institutionName?: string
  reference: string
  expectedAmount: string
  expectedCurrency: string
  currentStatus: string
  receivedAmount?: string
  receivedCurrency?: string
  afriexTransactionId?: string
  /** Settled deposits beyond the one that paid the session. Each needs a refund. */
  extraDeposits?: AfriexExtraDeposit[]
  instructions: AfriexPaymentInstructions
}
