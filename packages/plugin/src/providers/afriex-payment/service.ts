import { createPublicKey } from "node:crypto"
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  PaymentActions,
} from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  CreateAccountHolderInput,
  CreateAccountHolderOutput,
  DeleteAccountHolderInput,
  DeleteAccountHolderOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { WEBHOOK_SIGNATURE_HEADER } from "@afriex/sdk"
import type { AfriexSDK, PaymentMethod } from "@afriex/sdk"
import { createAfriexSdk, normalizePublicKey } from "../../lib/afriex"
import { amountsEqual, toAmountNumber, toAmountString } from "../../lib/amounts"
import { buildPaymentInstructions } from "../../lib/build-instructions"
import { AFRIEX_PROVIDER_IDENTIFIER } from "../../lib/constants"
import {
  isFinalRecordedStatus,
  mapAfriexStatusToMedusaStatus,
} from "../../lib/map-status"
import type {
  AfriexCollectionAccount,
  AfriexProviderOptions,
  AfriexSessionData,
} from "../../lib/types"
import { getSessionId, isTransactionEvent } from "../../lib/webhook-mapping"

type InjectedDependencies = {
  logger: Logger
}

const ENVIRONMENTS = ["staging", "production"] as const

/** The one currency Afriex will open a virtual account in on behalf of a customer. */
const CUSTOMER_ACCOUNT_CURRENCY = "NGN"

class AfriexPaymentProviderService extends AbstractPaymentProvider<AfriexProviderOptions> {
  static identifier = AFRIEX_PROVIDER_IDENTIFIER

  protected readonly logger_: Logger
  protected readonly options_: AfriexProviderOptions
  protected readonly afriex_: AfriexSDK

  static validateOptions(options: Record<string, unknown>): void {
    for (const required of ["apiKey", "webhookPublicKey", "environment"]) {
      if (!options[required]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_ARGUMENT,
          `Afriex payment provider: \`${required}\` is required in medusa-config.ts.`
        )
      }
    }

    // The SDK silently falls back to production when this is missing or
    // misspelled. The target environment has to be an explicit decision.
    if (!ENVIRONMENTS.includes(options.environment as (typeof ENVIRONMENTS)[number])) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `Afriex payment provider: \`environment\` must be "staging" or "production".`
      )
    }

    if (
      options.collectionMethod &&
      options.collectionMethod !== "dedicated" &&
      options.collectionMethod !== "pool"
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        `Afriex payment provider: \`collectionMethod\` must be "dedicated" or "pool".`
      )
    }

    // The SDK swallows a key it cannot parse and reports every signature as
    // invalid, which would surface only as Afriex retrying against a 401.
    // Fail at boot instead, where the operator is looking.
    try {
      createPublicKey(normalizePublicKey(String(options.webhookPublicKey)))
    } catch {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        "Afriex payment provider: `webhookPublicKey` is not a valid public key. Paste the PEM exactly as shown in the Afriex dashboard."
      )
    }
  }

  constructor(container: InjectedDependencies, options: AfriexProviderOptions) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.afriex_ = createAfriexSdk(options)
  }

  private get collectionMethod() {
    return this.options_.collectionMethod ?? "dedicated"
  }

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

    try {
      const account =
        this.collectionMethod === "dedicated"
          ? await this.createDedicatedAccount(input, {
              sessionId,
              currency,
              countryCode,
              amount: toAmountNumber(input.amount),
            })
          : await this.findPoolAccount({ sessionId, countryCode })

      const data: AfriexSessionData = {
        afriexPaymentMethodId: account.paymentMethodId,
        afriexCustomerId: account.customerId,
        collectionMethod: this.collectionMethod,
        accountNumber: account.accountNumber,
        accountName: account.accountName,
        institutionName: account.institutionName,
        reference: account.reference,
        expectedAmount: toAmountString(input.amount),
        expectedCurrency: currency,
        currentStatus: "PENDING",
        instructions: buildPaymentInstructions(account, this.collectionMethod),
      }

      return {
        id: account.paymentMethodId,
        status: "pending",
        data: data as unknown as Record<string, unknown>,
      }
    } catch (error) {
      // Fail loudly. A session that looks valid but can never be paid is worse
      // than a checkout that visibly refuses to proceed. The upstream detail
      // goes to the log, not to the shopper: Afriex error text describes the
      // merchant's account, not anything the customer can act on.
      this.logger_.error(
        `Afriex payment initiation failed for session ${sessionId}: ${
          (error as Error).message
        }`
      )

      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Afriex payment initiation failed. Please try again or choose another payment method."
      )
    }
  }

  /**
   * Reads the status the webhook handler last recorded rather than calling
   * Afriex. Checkout polls this, and putting a network call on that path would
   * rate-limit the storefront to no benefit — the webhook is what moves state.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = input.data as AfriexSessionData | undefined

    return {
      status: mapAfriexStatusToMedusaStatus(data?.currentStatus),
      data: input.data,
    }
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
    const data = input.data as AfriexSessionData | undefined
    const status = mapAfriexStatusToMedusaStatus(data?.currentStatus)

    return {
      status: status === "pending" ? "pending_authorization" : status,
      data: input.data,
    }
  }

  /**
   * Nothing to call: an Afriex deposit has already settled by the time the
   * webhook reports it. Capture exists so Medusa can record it.
   */
  async capturePayment(
    input: CapturePaymentInput
  ): Promise<CapturePaymentOutput> {
    return { data: input.data }
  }

  /**
   * A dedicated virtual account outlives the session it was minted for unless
   * it is closed, and a shopper who pays into it afterwards produces a deposit
   * no session can claim. So it is closed here. Pool accounts are shared
   * infrastructure and are left alone.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    await this.closeDedicatedAccount(input.data as AfriexSessionData | undefined)
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    await this.closeDedicatedAccount(input.data as AfriexSessionData | undefined)
    return { data: input.data }
  }

  async retrievePayment(
    input: RetrievePaymentInput
  ): Promise<RetrievePaymentOutput> {
    const data = input.data as AfriexSessionData | undefined

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
    const data = input.data as AfriexSessionData | undefined
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

    if (this.collectionMethod === "pool") {
      // A pool account is not bound to an amount, so a changed total only
      // changes what the plugin expects to receive.
      return {
        data: {
          ...data,
          expectedAmount: amount,
          expectedCurrency: currency,
        } as unknown as Record<string, unknown>,
      }
    }

    // A dynamic virtual account is scoped to an exact amount, so a changed cart
    // total needs a new account. The old one is closed so a late transfer into
    // it cannot land as an orphaned deposit.
    const account = await this.createDedicatedAccount(input, {
      sessionId: data.reference,
      currency,
      countryCode: this.resolveCountryCode(input),
      amount: toAmountNumber(input.amount),
    })

    await this.closeDedicatedAccount(data)

    const updated: AfriexSessionData = {
      ...data,
      afriexPaymentMethodId: account.paymentMethodId,
      afriexCustomerId: account.customerId,
      accountNumber: account.accountNumber,
      accountName: account.accountName,
      institutionName: account.institutionName,
      reference: account.reference,
      expectedAmount: amount,
      expectedCurrency: currency,
      instructions: buildPaymentInstructions(account, this.collectionMethod),
    }

    return { data: updated as unknown as Record<string, unknown> }
  }

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Refunds are not supported in v1 of the Afriex Medusa payment provider. Refund the customer out of band and record it manually."
    )
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

    const customerId = await this.registerAfriexCustomer(
      input.context.customer,
      input.context.customer.billing_address?.country_code?.toUpperCase() ??
        this.options_.defaultCountryCode ??
        "NG"
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

  /**
   * Serves Medusa's built-in `/hooks/payment/{provider}` endpoint, and is what
   * the plugin's own `/afriex/webhook` route calls to verify a signature.
   *
   * On the built-in endpoint this mapping alone is not enough to capture a
   * deposit: capture is gated on `currentStatus`, which only the plugin's
   * route writes. Register `/afriex/webhook` with Afriex, not this one.
   */
  async getWebhookActionAndData(
    payload: ProviderWebhookPayload["payload"]
  ): Promise<WebhookActionResult> {
    const signature = payload.headers?.[WEBHOOK_SIGNATURE_HEADER]
    const rawBody = payload.rawData?.toString()

    if (!rawBody || typeof signature !== "string") {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    let event
    try {
      event = this.afriex_.webhooks.verifyAndParse(rawBody, signature)
    } catch {
      this.logger_.warn("Afriex webhook rejected: invalid signature")
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    if (!isTransactionEvent(event)) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    // `not_supported` is reserved for "this did not verify" — the plugin's
    // route reads it as exactly that. A verified event that simply carries no
    // reference is still verified, and may yet be matched by its account, so
    // it is reported with an empty session id. Medusa's own webhook subscriber
    // ignores any result without a session id, so nothing acts on it there.
    const reference: unknown = getSessionId(event.data)
    const sessionId = typeof reference === "string" ? reference : ""

    const data = {
      session_id: sessionId,
      amount: new BigNumber(Number(event.data.destinationAmount)),
    }

    switch (mapAfriexStatusToMedusaStatus(event.data.status)) {
      case "captured":
        return { action: PaymentActions.SUCCESSFUL, data }
      case "error":
        return { action: PaymentActions.FAILED, data }
      case "canceled":
        return { action: PaymentActions.CANCELED, data }
      case "requires_more":
        return { action: PaymentActions.REQUIRES_MORE, data }
      default:
        return { action: PaymentActions.PENDING, data }
    }
  }

  private async createDedicatedAccount(
    input: InitiatePaymentInput | UpdatePaymentInput,
    params: {
      sessionId: string
      currency: string
      countryCode: string
      amount: number
    }
  ): Promise<AfriexCollectionAccount> {
    // Afriex only mints customer-owned virtual accounts in NGN; any other
    // currency with a customerId is refused outright
    // (UNSUPPORTED_VIRTUAL_ACCOUNT_CURRENCY). Those accounts are created for
    // the business instead, which is what Afriex's own docs prescribe.
    const customerId =
      params.currency === CUSTOMER_ACCOUNT_CURRENCY
        ? await this.resolveAfriexCustomerId(input, params.countryCode)
        : undefined

    const paymentMethod = await this.afriex_.paymentMethods.createVirtualAccount({
      currency: params.currency,
      ...(customerId ? { customerId } : {}),
      country: params.countryCode,
      amount: params.amount,
      reference: params.sessionId,
    })

    return this.toCollectionAccount(paymentMethod, params.sessionId, customerId)
  }

  /**
   * Pool accounts are shared, standing accounts — nothing is created per order.
   * The reference the customer quotes on the transfer is what attributes the
   * deposit, which is why it is mandatory in the instructions for this method.
   */
  private async findPoolAccount(params: {
    sessionId: string
    countryCode: string
  }): Promise<AfriexCollectionAccount> {
    const paymentMethod = await this.afriex_.paymentMethods.listPoolAccounts({
      country: params.countryCode,
    })

    return this.toCollectionAccount(paymentMethod, params.sessionId)
  }

  private async closeDedicatedAccount(
    data: AfriexSessionData | undefined
  ): Promise<void> {
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
    countryCode: string
  ): Promise<string | undefined> {
    const fromAccountHolder = input.context?.account_holder?.data?.customerId
    if (typeof fromAccountHolder === "string" && fromAccountHolder) {
      return fromAccountHolder
    }

    const fromSession = (input.data as AfriexSessionData | undefined)?.afriexCustomerId
    if (typeof fromSession === "string" && fromSession) {
      return fromSession
    }

    return this.registerAfriexCustomer(input.context?.customer, countryCode)
  }

  private async registerAfriexCustomer(
    customer:
      | NonNullable<InitiatePaymentInput["context"]>["customer"]
      | undefined,
    countryCode: string
  ): Promise<string | undefined> {
    const email = customer?.email?.trim()
    const phone = customer?.phone?.trim()

    // Afriex rejects a customer without both. Rather than send empty strings
    // and fail the checkout, let the account be business-owned.
    if (!email || !phone) {
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

  private resolveCountryCode(
    input: InitiatePaymentInput | UpdatePaymentInput
  ): string {
    return (
      input.context?.customer?.billing_address?.country_code?.toUpperCase() ??
      this.options_.defaultCountryCode ??
      "NG"
    )
  }
}

export default AfriexPaymentProviderService
