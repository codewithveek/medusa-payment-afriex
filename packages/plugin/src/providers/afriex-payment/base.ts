import { createPublicKey } from "node:crypto"
import {
  AbstractPaymentProvider,
  BigNumber,
  MedusaError,
  Modules,
  PaymentActions,
} from "@medusajs/framework/utils"
import type {
  CapturePaymentInput,
  CapturePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  IEventBusModuleService,
  InitiatePaymentInput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  UpdatePaymentInput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import { WEBHOOK_SIGNATURE_HEADER } from "@afriex/sdk"
import type { AfriexSDK } from "@afriex/sdk"
import { createAfriexSdk, normalizePublicKey } from "../../lib/afriex"
import {
  AFRIEX_PLUGIN_ROUTE_MARKER,
  AFRIEX_WEBHOOK_PATH,
  type AfriexMethod,
} from "../../lib/constants"
import { isCheckoutChannel } from "../../lib/checkout-channels"
import { currencyCoverage } from "../../lib/coverage"
import { mapAfriexStatus } from "../../lib/map-status"
import { returnUrlProblem } from "../../lib/return-url"
import type { AfriexProviderOptions, AfriexSessionBase } from "../../lib/types"
import {
  getSessionId,
  isCheckoutSessionEvent,
  isTransactionEvent,
} from "../../lib/webhook-mapping"

export type InjectedDependencies = {
  logger: Logger
}

const ENVIRONMENTS = ["staging", "production"] as const

function invalidCheckout(message: string): MedusaError {
  return new MedusaError(
    MedusaError.Types.INVALID_ARGUMENT,
    `Afriex payment provider: \`checkout.${message}`
  )
}

/**
 * The `checkout` block is optional — bank transfer needs none of it, and a
 * store without it simply cannot start a checkout payment — but whatever is
 * there must be usable, or the problem would first show up as a shopper's
 * failed payment.
 */
function validateCheckoutOptions(checkout: unknown): void {
  if (checkout === undefined || checkout === null) {
    return
  }
  if (typeof checkout !== "object" || Array.isArray(checkout)) {
    throw invalidCheckout("` must be an object.")
  }

  const options = checkout as Record<string, unknown>

  if (options.returnUrl !== undefined) {
    const problem = returnUrlProblem(options.returnUrl)
    if (problem) {
      throw invalidCheckout(`returnUrl\` ${problem}.`)
    }
  }

  if (options.allowedReturnOrigins !== undefined) {
    const origins = options.allowedReturnOrigins
    if (
      !Array.isArray(origins) ||
      !origins.every((origin) => {
        try {
          const url = new URL(String(origin))
          return url.protocol === "https:" && url.origin === origin
        } catch {
          return false
        }
      })
    ) {
      throw invalidCheckout(
        "allowedReturnOrigins` must be a list of HTTPS origins, like \"https://shop.example.com\"."
      )
    }
  }

  if (options.channels !== undefined) {
    const channels = options.channels
    if (!Array.isArray(channels) || !channels.length || !channels.every(isCheckoutChannel)) {
      throw invalidCheckout(
        "channels` must list at least one of VIRTUAL_BANK_ACCOUNT, MOBILE_MONEY, CARD."
      )
    }
  }

  if (options.currencyChannels !== undefined) {
    const map = options.currencyChannels
    if (
      !map ||
      typeof map !== "object" ||
      Array.isArray(map) ||
      !Object.entries(map).every(
        ([currency, channels]) =>
          /^[A-Za-z]{3}$/.test(currency) &&
          Array.isArray(channels) &&
          channels.every(isCheckoutChannel)
      )
    ) {
      throw invalidCheckout(
        "currencyChannels` must map 3-letter currency codes to lists of VIRTUAL_BANK_ACCOUNT, MOBILE_MONEY, CARD."
      )
    }
  }

  if (options.minorUnitExponents !== undefined) {
    const map = options.minorUnitExponents
    if (
      !map ||
      typeof map !== "object" ||
      Array.isArray(map) ||
      !Object.entries(map).every(
        ([currency, exponent]) =>
          /^[A-Za-z]{3}$/.test(currency) &&
          Number.isInteger(exponent) &&
          (exponent as number) >= 0 &&
          (exponent as number) <= 3
      )
    ) {
      throw invalidCheckout(
        "minorUnitExponents` must map 3-letter currency codes to whole numbers from 0 to 3."
      )
    }
  }
}

function validateBankTransferOptions(bankTransfer: unknown): void {
  if (bankTransfer === undefined || bankTransfer === null) {
    return
  }
  if (typeof bankTransfer !== "object" || Array.isArray(bankTransfer)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      "Afriex payment provider: `bankTransfer` must be an object."
    )
  }

  const currencies = (bankTransfer as Record<string, unknown>).currencies
  if (
    currencies !== undefined &&
    (!Array.isArray(currencies) ||
      !currencies.every((currency) => typeof currency === "string" && /^[A-Za-z]{3}$/.test(currency)))
  ) {
    throw new MedusaError(
      MedusaError.Types.INVALID_ARGUMENT,
      'Afriex payment provider: `bankTransfer.currencies` must be a list of 3-letter currency codes, like ["GHS"].'
    )
  }
}

/**
 * What every Afriex payment method shares: the options and the SDK built from
 * them, webhook verification, and the parts of the payment lifecycle that do
 * not depend on how the money is collected. Both methods are registered from
 * one configuration block, so they validate the same options and hold the same
 * keys.
 */
export abstract class AfriexProviderBase extends AbstractPaymentProvider<AfriexProviderOptions> {
  /** Which method this provider collects by, for status mapping. */
  protected abstract readonly method: AfriexMethod

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

    if (
      options.defaultCountryCode !== undefined &&
      !/^[A-Za-z]{2}$/.test(String(options.defaultCountryCode))
    ) {
      throw new MedusaError(
        MedusaError.Types.INVALID_ARGUMENT,
        'Afriex payment provider: `defaultCountryCode` must be a 2-letter country code, like "NG".'
      )
    }

    validateBankTransferOptions(options.bankTransfer)
    validateCheckoutOptions(options.checkout)
  }

  constructor(container: InjectedDependencies, options: AfriexProviderOptions) {
    super(container, options)

    this.logger_ = container.logger
    this.options_ = options
    this.afriex_ = createAfriexSdk(options)
  }

  /**
   * Reads the status the webhook handler last recorded rather than calling
   * Afriex. Only a webhook moves payment state; a network call here would add
   * nothing but a rate limit.
   */
  async getPaymentStatus(
    input: GetPaymentStatusInput
  ): Promise<GetPaymentStatusOutput> {
    const data = input.data as Partial<AfriexSessionBase> | undefined

    return {
      status: mapAfriexStatus(data?.currentStatus, this.method),
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

  async refundPayment(_input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Refunds are not supported in v1 of the Afriex Medusa payment provider. Refund the customer out of band and record it manually."
    )
  }

  /**
   * What the plugin's own `/afriex/webhook` route calls to verify a signature.
   *
   * Medusa also calls this for its built-in `/hooks/payment/{provider}`
   * endpoint, and that endpoint cannot handle Afriex safely: it captures the
   * session's full amount without checking what actually arrived, answers 200
   * before processing so Afriex never retries a failure, and gives the provider
   * nowhere to record anything. Left alone, a store pointed at it would simply
   * never see an order get paid. So a genuine Afriex event that arrives that
   * way is refused and logged at error level, naming the URL to use instead.
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

    // Checked only after the signature verifies, so this is a real Afriex
    // event on the wrong URL and not internet noise filling the error log.
    if (!payload.headers?.[AFRIEX_PLUGIN_ROUTE_MARKER]) {
      const transactionId = isTransactionEvent(event)
        ? ` for transaction ${event.data.transactionId}`
        : ""
      this.logger_.error(
        `Afriex ${event.event} event${transactionId} arrived on Medusa's generic /hooks/payment endpoint, which this provider does not support. It was NOT processed and no order was updated. Register https://<your-server>${AFRIEX_WEBHOOK_PATH} as the webhook URL in the Afriex dashboard instead.`
      )
      return { action: PaymentActions.NOT_SUPPORTED }
    }

    // A checkout-session event is verified, but carries no payment: it is how
    // the plugin learns a link's real expiry. `not_supported` would read as
    // "did not verify", so it answers pending with no session id — which
    // Medusa's own subscriber ignores — and the plugin's route takes it from
    // there.
    if (isCheckoutSessionEvent(event)) {
      return {
        action: PaymentActions.PENDING,
        data: { session_id: "", amount: new BigNumber(0) },
      }
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

    switch (mapAfriexStatus(event.data.status, this.method)) {
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

  /**
   * Announces a reference to the plugin's ledger. The provider runs inside the
   * payment module's container, which has the event bus but not the plugin's
   * own module, so the ledger is written by a subscriber.
   *
   * Best effort by design: failing to announce must never fail a payment. The
   * reference then simply is not in the ledger, and a payment on it after its
   * session is gone is logged as unmatched, as it always was.
   */
  protected async announce(name: string, data: Record<string, unknown>): Promise<void> {
    try {
      const eventBus = this.container[Modules.EVENT_BUS] as
        | IEventBusModuleService
        | undefined

      if (!eventBus) {
        this.logger_.warn(
          `Afriex could not record ${String(data.reference)} in its payment ledger: no event bus is available.`
        )
        return
      }

      await eventBus.emit({ name, data })
    } catch (error) {
      this.logger_.warn(
        `Afriex could not record ${String(data.reference)} in its payment ledger: ${(error as Error).message}`
      )
    }
  }

  /**
   * The country a payment is for: the billing address, else the country the
   * currency names (KES is Kenya's), else what the store set as its default.
   * Undefined when none of those says — a guess would register the shopper
   * in the wrong country.
   */
  protected resolveCountryCode(
    input: InitiatePaymentInput | UpdatePaymentInput
  ): string | undefined {
    return (
      input.context?.customer?.billing_address?.country_code?.toUpperCase() ||
      currencyCoverage(input.currency_code).homeCountry ||
      this.options_.defaultCountryCode?.toUpperCase() ||
      undefined
    )
  }
}
