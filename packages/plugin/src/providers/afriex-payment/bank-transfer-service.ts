import { MedusaError } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CreateAccountHolderInput,
  CreateAccountHolderOutput,
  DeleteAccountHolderInput,
  DeleteAccountHolderOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
} from "@medusajs/framework/types"
import type { PaymentMethod } from "@afriex/sdk"
import { amountsEqual, toAmountNumber, toAmountString } from "../../lib/amounts"
import { buildPaymentInstructions } from "../../lib/build-instructions"
import { BankTransferErrorCode, checkoutRefusal as refusal } from "../../lib/checkout-errors"
import {
  AFRIEX_PROVIDER_IDENTIFIER,
  AFRIEX_REFERENCE_CREATED,
  AFRIEX_REFERENCE_SUPERSEDED,
} from "../../lib/constants"
import { isFinalRecordedStatus, mapAfriexStatus } from "../../lib/map-status"
import { bankTransferAvailability } from "../../lib/method-availability"
import type {
  AfriexBankTransferSessionData,
  AfriexCollectionAccount,
} from "../../lib/types"
import { AfriexProviderBase } from "./base"

/** The one currency Afriex will open a virtual account in on behalf of a customer. */
const CUSTOMER_ACCOUNT_CURRENCY = "NGN"

/**
 * Bank transfer into a virtual account Afriex creates for the order. The
 * shopper is shown the account details in the store; the deposit is confirmed
 * by webhook.
 */
class AfriexBankTransferService extends AfriexProviderBase {
  static identifier = AFRIEX_PROVIDER_IDENTIFIER

  protected readonly method = "bank_transfer" as const

  /**
   * Called when the customer selects Afriex at checkout. There is no
   * synchronous "payment complete" step — this mints the account the customer
   * transfers into, and the deposit is confirmed later by webhook.
   */
  async initiatePayment(
    input: InitiatePaymentInput
  ): Promise<InitiatePaymentOutput> {
    // Medusa puts the payment session id here before calling the provider. It
    // becomes the Afriex reference, which is the only thread tying a later
    // webhook back to this cart.
    const sessionId = input.data?.session_id as string | undefined

    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Afriex payment provider: no payment session id was supplied, so an incoming deposit could never be matched back to this order."
      )
    }

    const currency = input.currency_code.toUpperCase()
    const countryCode = this.resolveCountryCode(input)

    // Refused before Afriex is asked, so the shopper learns at once — and, on
    // a cart, before any order exists.
    const availability = bankTransferAvailability(currency, this.options_)
    if (!availability.available) {
      this.logger_.warn(
        `Afriex bank transfer refused ${currency} for session ${sessionId}: ${availability.reason}${
          availability.why === "coming_soon"
            ? ` Once Afriex confirms ${currency} for your store, list it in bankTransfer.currencies in medusa-config.ts.`
            : ""
        }`
      )
      throw refusal(
        BankTransferErrorCode.UNAVAILABLE_FOR_CURRENCY,
        `Bank transfer isn't available for ${currency} payments. Please choose another payment method.`
      )
    }

    try {
      const account = await this.createDedicatedAccount(input, {
        sessionId,
        currency,
        countryCode,
        amount: toAmountNumber(input.amount),
      })

      // Medusa stores what the storefront sent merged under what this returns,
      // so every key the plugin later trusts is set here explicitly — a
      // storefront cannot seed a status, a received amount or a refund line.
      const data: AfriexBankTransferSessionData = {
        method: "bank_transfer",
        afriexPaymentMethodId: account.paymentMethodId,
        afriexCustomerId: account.customerId ?? null,
        collectionMethod: "dedicated",
        accountNumber: account.accountNumber,
        accountName: account.accountName ?? null,
        institutionName: account.institutionName ?? null,
        reference: account.reference,
        expectedAmount: toAmountString(input.amount),
        expectedCurrency: currency,
        currentStatus: "PENDING",
        receivedAmount: null,
        receivedCurrency: null,
        afriexTransactionId: null,
        extraDeposits: [],
        instructions: buildPaymentInstructions(account),
      }

      await this.announceAccount(sessionId, account, data)

      return {
        id: account.paymentMethodId,
        status: "pending",
        data: data as unknown as Record<string, unknown>,
      }
    } catch (error) {
      throw this.toShopperError(error, sessionId, currency)
    }
  }

  /**
   * Turns an Afriex failure into what the shopper should see. Two answers are
   * refusals with a code a storefront can act on: the store is not yet
   * approved to collect this currency, and the currency cannot be collected
   * this way. Everything else fails loudly — a session that looks valid but
   * can never be paid is worse than a checkout that visibly refuses — with the
   * upstream detail in the log, not in front of the shopper: Afriex's error
   * text describes the merchant's account, not anything a customer can act on.
   */
  private toShopperError(error: unknown, sessionId: string, currency: string): MedusaError {
    const failure = error as { message?: string; errorCode?: string; statusCode?: number }

    if (failure?.errorCode === "VIRTUAL_ACCOUNT_PENDING_COMPLIANCE_REVIEW") {
      this.logger_.error(
        `Afriex has not approved ${currency} virtual accounts for this store yet (VIRTUAL_ACCOUNT_PENDING_COMPLIANCE_REVIEW), so bank transfer in ${currency} was refused for session ${sessionId}. Afriex reviews the first request in each currency; ask Afriex support how it is going. Until then, turn bank transfer off in your ${currency} regions.`
      )
      return refusal(
        BankTransferErrorCode.AWAITING_APPROVAL,
        `Bank transfer isn't available for ${currency} payments yet. Please choose another payment method.`
      )
    }

    if (failure?.errorCode === "UNSUPPORTED_VIRTUAL_ACCOUNT_CURRENCY") {
      this.logger_.error(
        `Afriex does not open virtual accounts in ${currency} (UNSUPPORTED_VIRTUAL_ACCOUNT_CURRENCY), so bank transfer was refused for session ${sessionId}. Turn bank transfer off in your ${currency} regions, or remove ${currency} from bankTransfer.currencies.`
      )
      return refusal(
        BankTransferErrorCode.UNAVAILABLE_FOR_CURRENCY,
        `Bank transfer isn't available for ${currency} payments. Please choose another payment method.`
      )
    }

    this.logger_.error(
      `Afriex payment initiation failed for session ${sessionId}: ${
        failure?.statusCode ? `HTTP ${failure.statusCode} ` : ""
      }${failure?.errorCode ? `${failure.errorCode} ` : ""}${failure?.message ?? String(error)}`
    )

    return new MedusaError(
      MedusaError.Types.UNEXPECTED_STATE,
      "Afriex payment initiation failed. Please try again or choose another payment method."
    )
  }

  /**
   * Runs at cart completion. Unless the deposit has already been confirmed,
   * this returns `pending_authorization` — Medusa then creates the order in an
   * awaiting-payment state instead of blocking the customer at checkout, and
   * the webhook authorizes and captures it when the money actually lands.
   */
  async authorizePayment(
    input: AuthorizePaymentInput
  ): Promise<AuthorizePaymentOutput> {
    const data = input.data as Partial<AfriexBankTransferSessionData> | undefined
    const status = mapAfriexStatus(data?.currentStatus, this.method)

    return {
      status: status === "pending" ? "pending_authorization" : status,
      data: input.data,
    }
  }

  /**
   * A dedicated virtual account outlives the session it was minted for unless
   * it is closed, and a shopper who pays into it afterwards produces a deposit
   * no session can claim. So it is closed here.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    await this.retire(input.data as Partial<AfriexBankTransferSessionData> | undefined)
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    await this.retire(input.data as Partial<AfriexBankTransferSessionData> | undefined)
    return { data: input.data }
  }

  /**
   * The session is going away. Its account is closed, and the ledger is told,
   * so a transfer that still lands on it is held for its order instead of
   * being dropped.
   */
  private async retire(data: Partial<AfriexBankTransferSessionData> | undefined): Promise<void> {
    await this.closeDedicatedAccount(data)

    if (data?.collectionMethod === "dedicated" && data.reference) {
      await this.announce(AFRIEX_REFERENCE_SUPERSEDED, { reference: data.reference })
    }
  }

  private async announceAccount(
    sessionId: string,
    account: AfriexCollectionAccount,
    data: AfriexBankTransferSessionData
  ): Promise<void> {
    await this.announce(AFRIEX_REFERENCE_CREATED, {
      reference: account.reference,
      method: "bank_transfer",
      payment_session_id: sessionId,
      amount: data.expectedAmount,
      currency_code: data.expectedCurrency,
      account_id: account.paymentMethodId,
    })
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = input.data as Partial<AfriexBankTransferSessionData> | undefined

    if (!data?.afriexPaymentMethodId) {
      return { data: input.data }
    }

    const paymentMethod = await this.afriex_.paymentMethods.get(
      data.afriexPaymentMethodId
    )

    return { data: { ...data, afriexPaymentMethod: paymentMethod } }
  }

  /**
   * Medusa calls this whenever the session is updated — including when the
   * webhook handler writes a new status onto it. Only an actual change of
   * amount may mint a new account; anything else must pass the data through
   * untouched, or every status write would create a fresh virtual account.
   */
  async updatePayment(
    input: UpdatePaymentInput
  ): Promise<UpdatePaymentOutput> {
    const data = input.data as AfriexBankTransferSessionData | undefined
    const amount = toAmountString(input.amount)
    const currency = input.currency_code.toUpperCase()

    if (!data?.afriexPaymentMethodId) {
      return { data: input.data }
    }

    const unchanged =
      amountsEqual(data.expectedAmount, amount) &&
      data.expectedCurrency === currency

    if (unchanged) {
      return { data: input.data }
    }

    // Money has already moved against the old total. Carrying the settled
    // status onto a new amount would let Medusa mark the larger order paid.
    if (isFinalRecordedStatus(data.currentStatus)) {
      throw new MedusaError(
        MedusaError.Types.NOT_ALLOWED,
        `Afriex payment provider: the amount cannot change after a deposit has been recorded (status ${data.currentStatus}). Start a new payment session.`
      )
    }

    // A dynamic virtual account is scoped to an exact amount, so a changed cart
    // total needs a new account. The old one is closed so a late transfer into
    // it cannot land as an orphaned deposit.
    let account: AfriexCollectionAccount
    try {
      account = await this.createDedicatedAccount(input, {
        sessionId: data.reference,
        currency,
        countryCode: this.resolveCountryCode(input),
        amount: toAmountNumber(input.amount),
        sessionCustomerId: data.afriexCustomerId ?? undefined,
      })
    } catch (error) {
      throw this.toShopperError(error, data.reference, currency)
    }

    await this.closeDedicatedAccount(data)

    const updated: AfriexBankTransferSessionData = {
      ...data,
      afriexPaymentMethodId: account.paymentMethodId,
      afriexCustomerId: account.customerId ?? null,
      accountNumber: account.accountNumber,
      accountName: account.accountName ?? null,
      institutionName: account.institutionName ?? null,
      reference: account.reference,
      expectedAmount: amount,
      expectedCurrency: currency,
      instructions: buildPaymentInstructions(account),
    }

    await this.announceAccount(data.reference, account, updated)

    return { data: updated as unknown as Record<string, unknown> }
  }

  /**
   * Registers the shopper with Afriex once, so every later checkout reuses the
   * same Afriex customer instead of creating one per virtual account. Medusa
   * links the returned id to its customer and hands it back in
   * `context.account_holder` on subsequent sessions.
   *
   * Afriex requires an email and a phone number. A shopper without both gets
   * no account holder — an empty result tells Medusa nothing was created — and
   * their virtual accounts are minted against the business instead.
   */
  async createAccountHolder(
    input: CreateAccountHolderInput
  ): Promise<CreateAccountHolderOutput> {
    const existing = input.context.account_holder?.data?.customerId
    if (typeof existing === "string" && existing) {
      return { id: existing, data: { customerId: existing } }
    }

    // No order here to take a currency from, so only the address or the
    // store's default can say which country the shopper is in.
    const customerId = await this.registerAfriexCustomer(
      input.context.customer,
      input.context.customer.billing_address?.country_code?.toUpperCase() ||
        this.options_.defaultCountryCode?.toUpperCase() ||
        undefined
    )

    if (!customerId) {
      return {} as unknown as CreateAccountHolderOutput
    }

    return { id: customerId, data: { customerId } }
  }

  async deleteAccountHolder(
    input: DeleteAccountHolderInput
  ): Promise<DeleteAccountHolderOutput> {
    const customerId =
      input.context.account_holder.external_id ??
      (input.context.account_holder.data?.customerId as string | undefined)

    if (customerId) {
      try {
        await this.afriex_.customers.delete(customerId)
      } catch (error) {
        // Medusa is removing its own customer regardless; the Afriex record is
        // best effort and must not block that.
        this.logger_.warn(
          `Afriex customer ${customerId} could not be deleted: ${(error as Error).message}`
        )
      }
    }

    return { data: input.data }
  }

  private async createDedicatedAccount(
    input: InitiatePaymentInput | UpdatePaymentInput,
    params: {
      sessionId: string
      currency: string
      countryCode: string | undefined
      amount: number
      /** The customer this session's previous account was minted for. Only an update knows it. */
      sessionCustomerId?: string
    }
  ): Promise<AfriexCollectionAccount> {
    // Afriex only mints customer-owned virtual accounts in NGN; any other
    // currency with a customerId is refused outright
    // (UNSUPPORTED_VIRTUAL_ACCOUNT_CURRENCY). Those accounts are created for
    // the business instead, which is what Afriex's own docs prescribe.
    const customerId =
      params.currency === CUSTOMER_ACCOUNT_CURRENCY
        ? await this.resolveAfriexCustomerId(
            input,
            params.countryCode,
            params.sessionCustomerId
          )
        : undefined

    const paymentMethod = await this.afriex_.paymentMethods.createVirtualAccount({
      currency: params.currency,
      ...(customerId ? { customerId } : {}),
      ...(params.countryCode ? { country: params.countryCode } : {}),
      amount: params.amount,
      reference: params.sessionId,
    })

    return this.toCollectionAccount(paymentMethod, params.sessionId, customerId)
  }

  private async closeDedicatedAccount(
    data: Partial<AfriexBankTransferSessionData> | undefined
  ): Promise<void> {
    // Only an account minted for this session is this session's to close.
    // Data stored by older plugin versions may describe some other account.
    if (data?.collectionMethod !== "dedicated" || !data.afriexPaymentMethodId) {
      return
    }

    try {
      await this.afriex_.paymentMethods.delete(data.afriexPaymentMethodId)
    } catch (error) {
      // Closing is a courtesy to the reconciliation path, not a precondition
      // for Medusa's own cleanup. An account that could not be closed simply
      // expires on Afriex's schedule instead.
      this.logger_.warn(
        `Afriex virtual account ${data.afriexPaymentMethodId} could not be closed: ${
          (error as Error).message
        }`
      )
    }
  }

  private toCollectionAccount(
    paymentMethod: PaymentMethod,
    sessionId: string,
    customerId?: string
  ): AfriexCollectionAccount {
    if (!paymentMethod?.accountNumber) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Afriex returned a collection account without an account number, so there is nothing the customer could pay into."
      )
    }

    return {
      paymentMethodId: paymentMethod.paymentMethodId,
      customerId: customerId ?? paymentMethod.customerId ?? undefined,
      accountNumber: paymentMethod.accountNumber,
      accountName: paymentMethod.accountName,
      institutionName: paymentMethod.institution?.institutionName,
      reference: paymentMethod.reference ?? sessionId,
      expiresInMinutes: paymentMethod.expiresInMinutes,
    }
  }

  /**
   * Which Afriex customer a new virtual account belongs to, in order of
   * preference: the account holder Medusa already links to this shopper, the
   * customer a previous account on this same session was minted for, or a
   * newly registered one. Returns undefined when there is nobody to register —
   * the account is then owned by the business.
   */
  private async resolveAfriexCustomerId(
    input: InitiatePaymentInput | UpdatePaymentInput,
    countryCode: string | undefined,
    sessionCustomerId: string | undefined
  ): Promise<string | undefined> {
    const fromAccountHolder = input.context?.account_holder?.data?.customerId
    if (typeof fromAccountHolder === "string" && fromAccountHolder) {
      return fromAccountHolder
    }

    // Passed in only by an update, from data this provider wrote. At
    // initiation the session data is whatever the storefront sent, and a
    // storefront must never be able to name whose account gets minted.
    if (sessionCustomerId) {
      return sessionCustomerId
    }

    return this.registerAfriexCustomer(input.context?.customer, countryCode)
  }

  private async registerAfriexCustomer(
    customer:
      | NonNullable<InitiatePaymentInput["context"]>["customer"]
      | undefined,
    countryCode: string | undefined
  ): Promise<string | undefined> {
    const email = customer?.email?.trim()
    const phone = customer?.phone?.trim()

    // Afriex rejects a customer without all three. Rather than send empty
    // strings, or a country guessed at, and fail the checkout, let the account
    // be business-owned.
    if (!email || !phone || !countryCode) {
      return undefined
    }

    const fullName = [customer?.first_name, customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim()

    const created = await this.afriex_.customers.create({
      fullName: fullName || customer?.company_name || "Storefront Customer",
      email,
      phone,
      countryCode,
    })

    return created.customerId
  }
}

export default AfriexBankTransferService
