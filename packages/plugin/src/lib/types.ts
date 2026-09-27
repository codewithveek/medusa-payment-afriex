/** Payment rails an Afriex hosted checkout session can offer. */
export type AfriexCheckoutChannel = "VIRTUAL_BANK_ACCOUNT" | "MOBILE_MONEY" | "CARD"

export type AfriexCheckoutOptions = {
  /**
   * Where Afriex sends the shopper back to, over HTTPS. `{order_id}` in the
   * path is replaced with the order's id. Checkout refuses to start until set.
   */
  returnUrl?: string
  /** Other origins a storefront may ask to be sent back to. */
  allowedReturnOrigins?: string[]
  /** The channels checkout may offer at most. Afriex drops those a currency cannot collect. */
  channels?: AfriexCheckoutChannel[]
  /**
   * What checkout can collect in a currency, when Afriex's published coverage
   * (`lib/coverage.ts`) is behind. A currency named here uses this list instead.
   */
  currencyChannels?: Record<string, AfriexCheckoutChannel[]>
  /** The minor-unit exponent Afriex uses, where it differs from ISO 4217. */
  minorUnitExponents?: Record<string, number>
}

export type AfriexBankTransferOptions = {
  /**
   * Currencies Afriex has confirmed it opens virtual accounts in for this
   * store, beyond the ones its published coverage lists as live.
   */
  currencies?: string[]
}

export type AfriexProviderOptions = {
  apiKey: string
  environment: "staging" | "production"
  webhookPublicKey: string
  /**
   * The country to assume when neither the address nor the currency says.
   * Optional: most currencies name their country.
   */
  defaultCountryCode?: string
  /** Bank transfer settings. Optional. */
  bankTransfer?: AfriexBankTransferOptions
  /** Afriex hosted checkout. Optional: bank transfer works without it. */
  checkout?: AfriexCheckoutOptions
}

/**
 * The virtual account Afriex minted for one session, normalized from the SDK's
 * payment method so everything downstream — instructions, session data, the
 * admin widget — works off one shape.
 */
export type AfriexCollectionAccount = {
  paymentMethodId: string
  /** Afriex customer the account was minted for; absent when it is business-owned. */
  customerId?: string
  accountNumber: string
  accountName?: string
  institutionName?: string
  /** The Medusa payment session id Afriex echoes on every deposit, which the webhook is matched against. */
  reference: string
  /** Minutes until a dynamic virtual account stops accepting deposits, when Afriex reports it. */
  expiresInMinutes?: number
}

export type AfriexPaymentInstructions = {
  bankName?: string
  accountNumber: string
  accountName?: string
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
  currency?: string | null
  receivedAt: string
  /** Why it is here, when an admin put it here: `refund` or `excess`. */
  reason?: string
}

/**
 * What every Afriex session records, whichever way it collects. This is the
 * part the webhook handler reads and writes; the method-specific parts are
 * written once, when the session is created.
 */
export type AfriexSessionBase = {
  /** For readers only. Which method a session belongs to is decided by its provider id. */
  method?: "bank_transfer" | "checkout"
  reference: string
  /** What the order expected when the session was created. Checked against every deposit. */
  expectedAmount: string
  expectedCurrency: string
  currentStatus: string
  receivedAmount?: string | null
  receivedCurrency?: string | null
  afriexTransactionId?: string | null
  /** Settled deposits beyond the one that paid the session. Each needs a refund. */
  extraDeposits?: AfriexExtraDeposit[]
  /** Set when a payment made to an earlier, replaced reference was applied to this session. */
  paidViaReference?: string | null
  /** The admin user who resolved held money on this session, and when. */
  resolvedBy?: string | null
  resolvedAt?: string | null
  /** When Afriex last reported progress on a transaction for this session. */
  lastEventAt?: string | null
  /** The rail the latest transaction used, and the one that paid. */
  lastChannel?: string | null
  paidChannel?: string | null
  /** Why the latest transaction failed, in Afriex's own customer-safe words. */
  failureReason?: AfriexFailureReason | null
  /** The latest transactions on this session, newest last, so failures are not overwritten. */
  transactions?: AfriexTransactionRecord[]
  /** Set when a person should look at this session although nothing was captured or held. */
  needsAttention?: string | null
}

export type AfriexFailureReason = {
  code?: string
  message?: string
  retryable?: boolean
  at: string
}

export type AfriexTransactionRecord = {
  transactionId: string
  status: string
  channel?: string | null
  amount?: string | null
  otpRequired?: boolean
  at: string
}

/**
 * Everything the bank-transfer provider persists on the Medusa payment session.
 * `currentStatus` and the received-money fields are what the webhook handler
 * mutates after initiation; the account details and expected amount are
 * written once, since an incoming deposit gets checked against them.
 */
export type AfriexBankTransferSessionData = AfriexSessionBase & {
  /** Absent on sessions stored before the method was recorded. */
  method?: "bank_transfer"
  afriexPaymentMethodId: string
  /** Afriex customer the collection account belongs to; null for business-owned accounts. */
  afriexCustomerId?: string | null
  /**
   * The account was minted for this session alone, which is what lets a
   * deposit be matched to it by account. Only such sessions are ever matched
   * or closed by account id.
   */
  collectionMethod: "dedicated"
  accountNumber: string
  accountName?: string | null
  institutionName?: string | null
  instructions: AfriexPaymentInstructions
}

/**
 * What the plugin's middleware puts in the session data before the checkout
 * provider sees it. Built on the server from the cart or order; the
 * storefront's own keys are removed first.
 */
export type AfriexCheckoutRequest = {
  /**
   * The admin asked to hide checkout's bank transfer, and this region offers
   * the plugin's own. The provider decides whether that is safe for the
   * currency.
   */
  hide_bank?: boolean | null
  stage: "select" | "pay"
  customer?: {
    name: string
    email: string
    phone: string
    countryCode: string
  }
  /** The admin's channel choice, when one is stored. The provider caps it further. */
  channels?: AfriexCheckoutChannel[] | null
  order_id?: string | null
  cart_id?: string | null
  payment_collection_id?: string | null
  /** A placeholder session the plugin creates itself to apply a held payment to. */
  purpose?: "apply"
}

/** What the hosted-checkout provider persists on the Medusa payment session. */
export type AfriexCheckoutSessionData = AfriexSessionBase & {
  method: "checkout"
  /** `selected` when the shopper chose checkout but no link exists yet; `open` once Afriex made one. */
  stage: "selected" | "open"
  expectedAmountMinor: string | null
  minorUnitExponent: number | null
  /** The major-unit amount actually sent to Afriex, after rounding. */
  chargedAmount: string | null
  /** The pay session's id: what every webhook for this link is matched on. */
  merchantReference: string | null
  /**
   * What was actually sent as Afriex's `merchantReference` when a sandbox
   * outcome was asked for in staging: the id plus Afriex's control words.
   * Null otherwise, and always in production.
   */
  sandboxReference: string | null
  checkoutUrl: string | null
  redirectUrl: string | null
  channelsRequested: AfriexCheckoutChannel[]
  /** What Afriex said the shopper will be offered, when its response said. */
  channelsOffered: AfriexCheckoutChannel[] | null
  createdAt: string
  /** From Afriex, once it tells us. */
  expiresAt: string | null
  /** Until then: when the link is assumed to expire. */
  expiresAtEstimate: string | null
  checkoutSessionId: string | null
  orderId: string | null
}

export type AfriexSessionData = AfriexBankTransferSessionData | AfriexCheckoutSessionData
