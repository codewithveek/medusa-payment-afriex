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
import { createAfriexSdk } from "../../lib/afriex"
import { amountsEqual, toAmountNumber, toAmountString } from "../../lib/amounts"
import { buildPaymentInstructions } from "../../lib/build-instructions"
import { AFRIEX_PROVIDER_IDENTIFIER } from "../../lib/constants"
import { mapAfriexStatusToMedusaStatus } from "../../lib/map-status"
import type {
  AfriexCollectionAccount,
  AfriexProviderOptions,
  AfriexSessionData,
} from "../../lib/types"
import { getSessionId, isTransactionEvent } from "../../lib/webhook-mapping"

type InjectedDependencies = {
  logger: Logger
}

class AfriexPaymentProviderService extends AbstractPaymentProvider<AfriexProviderOptions> {
  static identifier = AFRIEX_PROVIDER_IDENTIFIER

  protected readonly logger_: Logger
  protected readonly options_: AfriexProviderOptions
  protected readonly afriex_: AfriexSDK

  static validateOptions(options: Record<string, unknown>): void {
    for (const required of ["apiKey", "webhookPublicKey"]) {
      if (!options[required]) {
        throw new MedusaError(
          MedusaError.Types.INVALID_ARGUMENT,
          `Afriex payment provider: \`${required}\` is required in medusa-config.ts.`
        )
      }
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
      // than a checkout that visibly refuses to proceed.
      this.logger_.error(
        `Afriex payment initiation failed for session ${sessionId}: ${
          (error as Error).message
        }`
      )

      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        `Afriex payment initiation failed: ${(error as Error).message}`
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
   * Dedicated virtual accounts expire on their own and pool accounts are shared
   * infrastructure, so an abandoned cart leaves nothing to cancel at Afriex.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    return { data: input.data }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
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

    if (unchanged || this.collectionMethod === "pool") {
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
    // total needs a new account — the old one simply expires unused.
    const account = await this.createDedicatedAccount(input, {
      sessionId: data.reference,
      currency,
      countryCode: this.resolveCountryCode(input),
      amount: toAmountNumber(input.amount),
    })

    const updated: AfriexSessionData = {
      ...data,
      afriexPaymentMethodId: account.paymentMethodId,
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
   * Serves Medusa's built-in `/hooks/payment/{provider}` endpoint. The plugin's
   * own `/afriex/webhook` route is the recommended one — it adds idempotency
   * and amount-mismatch review on top of this mapping — so register one URL
   * with Afriex, not both.
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

    const sessionId = getSessionId(event.data)

    if (!sessionId) {
      return { action: PaymentActions.NOT_SUPPORTED }
    }

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
    const customerId = await this.resolveAfriexCustomerId(input, params.countryCode)

    const paymentMethod = await this.afriex_.paymentMethods.createVirtualAccount({
      currency: params.currency,
      customerId,
      country: params.countryCode,
      amount: params.amount,
      reference: params.sessionId,
    })

    return this.toCollectionAccount(paymentMethod, params.sessionId)
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

  private toCollectionAccount(
    paymentMethod: PaymentMethod,
    sessionId: string
  ): AfriexCollectionAccount {
    if (!paymentMethod?.accountNumber) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Afriex returned a collection account without an account number, so there is nothing the customer could pay into."
      )
    }

    return {
      paymentMethodId: paymentMethod.paymentMethodId,
      accountNumber: paymentMethod.accountNumber,
      accountName: paymentMethod.accountName,
      institutionName: paymentMethod.institution?.institutionName,
      reference: paymentMethod.reference ?? sessionId,
    }
  }

  /**
   * Reuses the Afriex customer Medusa already holds for this shopper when there
   * is one, and only registers a new customer otherwise — a guest checkout has
   * no account holder to reuse.
   */
  private async resolveAfriexCustomerId(
    input: InitiatePaymentInput | UpdatePaymentInput,
    countryCode: string
  ): Promise<string> {
    const existing = input.context?.account_holder?.data?.customerId

    if (typeof existing === "string" && existing) {
      return existing
    }

    const customer = input.context?.customer
    const fullName = [customer?.first_name, customer?.last_name]
      .filter(Boolean)
      .join(" ")
      .trim()

    const created = await this.afriex_.customers.create({
      fullName: fullName || customer?.company_name || "Storefront Customer",
      email: customer?.email ?? "",
      phone: customer?.phone ?? "",
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
