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
  accountNumber: string
  accountName?: string
  institutionName?: string
  /** What the customer must quote on the transfer, and what the webhook is matched against. */
  reference: string
}

export type AfriexPaymentInstructions = {
  bankName?: string
  accountNumber: string
  accountName?: string
  reference?: string
  note: string
  expiresNote?: string
}

/**
 * Everything the plugin persists on the Medusa payment session. `currentStatus`
 * is the only field the webhook handler mutates after initiation; the expected
 * amount/currency are written once and treated as immutable, since they are what
 * an incoming deposit gets checked against.
 */
export type AfriexSessionData = {
  afriexPaymentMethodId: string
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
  instructions: AfriexPaymentInstructions
}
