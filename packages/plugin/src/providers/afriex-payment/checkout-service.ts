import { MedusaError } from "@medusajs/framework/utils"
import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CreateAccountHolderInput,
  CreateAccountHolderOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
} from "@medusajs/framework/types"
import {
  amountsEqual,
  minorUnitExponent,
  toAfriexMinorUnits,
  toAmountString,
} from "../../lib/amounts"
import {
  effectiveChannels,
  isCheckoutChannel,
  SDK_ACCEPTED_CHECKOUT_CHANNELS,
} from "../../lib/checkout-channels"
import {
  CheckoutErrorCode,
  checkoutFailure,
  checkoutRefusal,
} from "../../lib/checkout-errors"
import {
  AFRIEX_CHECKOUT_PROVIDER_IDENTIFIER,
  AFRIEX_REFERENCE_CREATED,
  AFRIEX_REFERENCE_SUPERSEDED,
} from "../../lib/constants"
import { liveCheckoutChannels } from "../../lib/coverage"
import { mapAfriexStatus } from "../../lib/map-status"
import { checkoutAvailability } from "../../lib/method-availability"
import { buildRedirectUrl } from "../../lib/return-url"
import { readSandboxRequest, sandboxHint, withSandboxHint } from "../../lib/sandbox"
import type {
  AfriexCheckoutChannel,
  AfriexCheckoutRequest,
  AfriexCheckoutSessionData,
  AfriexProviderOptions,
} from "../../lib/types"
import { AfriexProviderBase, type InjectedDependencies } from "./base"

/**
 * How long a checkout link is assumed to stay payable until Afriex says. The
 * docs give no lifetime; their sample event puts one at about fifteen minutes.
 */
const ASSUMED_LINK_LIFETIME_MS = 15 * 60 * 1000

/**
 * Afriex hosted checkout: the shopper pays on Afriex's page — mobile money,
 * bank transfer, and card once the SDK allows it — and comes back.
 *
 * It works in two stages, decided by the plugin's middleware from whether the
 * cart has been completed:
 *
 * - `select`, on the cart: nothing is created at Afriex. The session only lets
 *   the cart complete into an order awaiting payment.
 * - `pay`, on the order's payment collection: the checkout session is created
 *   and the shopper is given its link.
 *
 * So a payable link only ever exists for an order that exists, with a total
 * that can no longer change through the cart.
 */
class AfriexCheckoutService extends AfriexProviderBase {
  static identifier = AFRIEX_CHECKOUT_PROVIDER_IDENTIFIER

  protected readonly method = "checkout" as const

  constructor(container: InjectedDependencies, options: AfriexProviderOptions) {
    super(container, options)

    if (options.checkout?.channels?.some((channel) => !SDK_ACCEPTED_CHECKOUT_CHANNELS.includes(channel))) {
      this.logger_.warn(
        `Afriex Checkout: the installed Afriex SDK accepts only ${SDK_ACCEPTED_CHECKOUT_CHANNELS.join(", ")}. The other channels in checkout.channels are not sent until it accepts them.`
      )
    }
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = input.data?.session_id as string | undefined

    if (!sessionId) {
      throw new MedusaError(
        MedusaError.Types.UNEXPECTED_STATE,
        "Afriex Checkout: no payment session id was supplied, so a payment could never be matched back to this order."
      )
    }

    const request = readRequest(input.data?.afriex)
    const settings = this.options_.checkout ?? {}
    const currency = input.currency_code.toUpperCase()

    // A placeholder the plugin creates itself to apply a held payment to. It
    // never reaches Afriex, so the storefront-facing checks do not apply.
    if (request.purpose === "apply") {
      return this.selected(sessionId, input, currency, {
        exponent: minorUnitExponent(currency, settings.minorUnitExponents),
        channels: [],
        orderId: request.order_id ?? null,
      })
    }

    if (!settings.returnUrl) {
      throw checkoutRefusal(
        CheckoutErrorCode.NOT_CONFIGURED,
        "Afriex Checkout is not set up yet (checkout.returnUrl is missing). Please choose another payment method."
      )
    }

    const exponent = minorUnitExponent(currency, settings.minorUnitExponents)
    const amounts = toAfriexMinorUnits(input.amount, exponent)
    if (amounts.minor < 100) {
      throw checkoutRefusal(
        CheckoutErrorCode.UNAVAILABLE_FOR_CURRENCY,
        "This order is below the smallest amount Afriex Checkout can collect. Please choose another payment method."
      )
    }

    // What this currency can collect on: the store's word, else Afriex's
    // published coverage. Refused here, on the cart, so an order is never
    // placed for a payment page that cannot take its currency.
    const availability = checkoutAvailability(currency, {
      options: this.options_,
      settings: {
        checkoutChannels: request.channels ?? null,
        hideBankChannelWhereBankTransfer: request.hide_bank === true,
        pausedRegions: null,
      },
      bankTransferHere: request.hide_bank === true,
    })
    if (!availability.available) {
      this.logger_.warn(
        `Afriex Checkout refused ${currency} for session ${sessionId}: ${availability.reason}${
          availability.why === "coming_soon"
            ? ` Once Afriex confirms ${currency} for your store, add it to checkout.currencyChannels in medusa-config.ts.`
            : ""
        }`
      )
      throw checkoutRefusal(
        CheckoutErrorCode.UNAVAILABLE_FOR_CURRENCY,
        `Afriex Checkout isn't available for ${currency} payments. Please choose another payment method.`
      )
    }
    const channels = availability.channels

    // What to fall back to if Afriex will not collect without the bank option.
    const withBankChannel = effectiveChannels({
      configured: settings.channels,
      adminChoice: request.channels,
      currencyChannels: settings.currencyChannels?.[currency] ?? liveCheckoutChannels(currency),
    })

    const redirect = buildRedirectUrl({
      returnUrl: settings.returnUrl,
      allowedReturnOrigins: settings.allowedReturnOrigins,
      requested: input.data?.return_url,
      orderId: request.order_id,
    })
    if ("refused" in redirect) {
      throw checkoutRefusal(CheckoutErrorCode.RETURN_URL_NOT_ALLOWED, redirect.refused)
    }

    const selected = this.selected(sessionId, input, currency, {
      exponent,
      channels,
      orderId: request.order_id ?? null,
    })

    // Only the pay stage talks to Afriex, and only with a customer the
    // middleware built on the server. Anything else stays a selection.
    if (request.stage !== "pay" || !request.customer) {
      return selected
    }

    const metadata = Object.fromEntries(
      Object.entries({
        medusa_payment_session_id: sessionId,
        medusa_payment_collection_id: request.payment_collection_id,
        medusa_order_id: request.order_id,
        medusa_cart_id: request.cart_id,
      }).filter((entry): entry is [string, string] => typeof entry[1] === "string" && !!entry[1])
    )

    // A test may choose the outcome in Afriex's sandbox through the reference.
    // Only staging listens; in production the request is dropped and said so.
    const sandbox = readSandboxRequest(input.data?.sandbox)
    let reference = sessionId
    if (sandbox && this.options_.environment === "staging") {
      reference = withSandboxHint(sessionId, sandboxHint(sandbox))
    } else if (sandbox) {
      this.logger_.warn(
        `Afriex Checkout ignored a sandbox request on session ${sessionId}: the store runs against production, which does not simulate outcomes.`
      )
    }

    const ask = (offered: AfriexCheckoutChannel[]) =>
      this.afriex_.checkout.createSession({
        amount: amounts.minor,
        currency,
        merchantReference: reference,
        redirectUrl: redirect.url,
        customer: request.customer!,
        channels: offered,
        metadata,
      })

    let requested = channels
    let created: { checkoutUrl: string; channels?: AfriexCheckoutChannel[] }
    try {
      created = await ask(channels)
    } catch (error) {
      // Afriex says none of these channels can collect this currency. If the
      // bank option was hidden on purpose, that is the likeliest reason — so
      // the shopper gets a payment link rather than the store's preference.
      const retryable =
        (error as { statusCode?: number })?.statusCode === 422 &&
        withBankChannel.length > channels.length

      if (!retryable) {
        throw this.toShopperError(error, sessionId)
      }

      this.logger_.warn(
        `Afriex Checkout could not collect ${currency} without its bank-transfer option, so it was offered after all for ${sessionId}. Add ${currency} to checkout.currencyChannels to stop hiding it here.`
      )

      try {
        created = await ask(withBankChannel)
        requested = withBankChannel
      } catch (retryError) {
        throw this.toShopperError(retryError, sessionId)
      }
    }

    const now = Date.now()
    const data: AfriexCheckoutSessionData = {
      ...(selected.data as unknown as AfriexCheckoutSessionData),
      stage: "open",
      merchantReference: sessionId,
      sandboxReference: reference === sessionId ? null : reference,
      checkoutUrl: created.checkoutUrl,
      redirectUrl: redirect.url,
      // What was asked for in the end, which the retry above may have widened.
      channelsRequested: requested,
      channelsOffered: Array.isArray(created.channels)
        ? created.channels.filter(isCheckoutChannel)
        : null,
      createdAt: new Date(now).toISOString(),
      expiresAtEstimate: new Date(now + ASSUMED_LINK_LIFETIME_MS).toISOString(),
    }

    await this.announce(AFRIEX_REFERENCE_CREATED, {
      reference: sessionId,
      method: "checkout",
      payment_session_id: sessionId,
      payment_collection_id: request.payment_collection_id ?? null,
      amount: amounts.charged,
      currency_code: currency,
      amount_minor: String(amounts.minor),
    })

    return {
      id: sessionId,
      status: "pending",
      data: data as unknown as Record<string, unknown>,
    }
  }

  /**
   * Runs at cart completion and when a payment is captured. Until Afriex
   * reports the money, this returns `pending_authorization`, which is what lets
   * the order be placed before the shopper pays.
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const data = input.data as Partial<AfriexCheckoutSessionData> | undefined
    const status = mapAfriexStatus(data?.currentStatus, this.method)

    return {
      status: status === "pending" ? "pending_authorization" : status,
      data: input.data,
    }
  }

  /**
   * The plugin writes status onto the session through this path, always with
   * the session's own amount, so that is passed through. A different amount
   * would need a different link, and a link's reference can never be reused.
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const data = input.data as Partial<AfriexCheckoutSessionData> | undefined

    if (
      !data?.expectedAmount ||
      (amountsEqual(data.expectedAmount, input.amount) &&
        data.expectedCurrency === input.currency_code.toUpperCase())
    ) {
      return { data: input.data }
    }

    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Afriex Checkout: the amount of a checkout payment cannot change. Start a new payment session."
    )
  }

  /**
   * Afriex has no way to cancel a checkout link, so a deleted or cancelled
   * session's link can still be paid until it expires. The ledger is told, so
   * such a payment is held for its order instead of being dropped. This never
   * throws: a throw here would stop the shopper switching payment method.
   */
  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    await this.retire(input.data as Partial<AfriexCheckoutSessionData> | undefined)
    return { data: input.data }
  }

  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    await this.retire(input.data as Partial<AfriexCheckoutSessionData> | undefined)
    return { data: input.data }
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    return { data: input.data }
  }

  /**
   * Checkout takes the customer inline with each session, so there is no
   * Afriex customer to register. An empty result tells Medusa none was made.
   */
  async createAccountHolder(_input: CreateAccountHolderInput): Promise<CreateAccountHolderOutput> {
    return {} as unknown as CreateAccountHolderOutput
  }

  private async retire(data: Partial<AfriexCheckoutSessionData> | undefined): Promise<void> {
    try {
      if (data?.stage === "open" && data.merchantReference) {
        await this.announce(AFRIEX_REFERENCE_SUPERSEDED, { reference: data.merchantReference })
      }
    } catch {
      // announce() already swallows its own failures; nothing here may throw.
    }
  }

  /**
   * The session as a selection: every key this provider later trusts is set,
   * and everything the storefront or an earlier session left is cleared.
   * Medusa stores what was sent merged under what this returns, and replays
   * old data when it undoes a step, so nothing may be left to chance.
   */
  private selected(
    sessionId: string,
    input: InitiatePaymentInput,
    currency: string,
    options: { exponent: number; channels: AfriexCheckoutChannel[]; orderId: string | null }
  ): InitiatePaymentOutput {
    const amounts = toAfriexMinorUnits(input.amount, options.exponent)

    const data: AfriexCheckoutSessionData & Record<string, unknown> = {
      method: "checkout",
      stage: "selected",
      reference: sessionId,
      expectedAmount: toAmountString(input.amount),
      expectedCurrency: currency,
      currentStatus: "PENDING",
      receivedAmount: null,
      receivedCurrency: null,
      afriexTransactionId: null,
      extraDeposits: [],
      paidViaReference: null,
      resolvedBy: null,
      resolvedAt: null,
      lastEventAt: null,
      lastChannel: null,
      paidChannel: null,
      failureReason: null,
      transactions: [],
      needsAttention: null,
      expectedAmountMinor: String(amounts.minor),
      minorUnitExponent: options.exponent,
      chargedAmount: amounts.charged,
      merchantReference: null,
      sandboxReference: null,
      checkoutUrl: null,
      redirectUrl: null,
      channelsRequested: options.channels,
      channelsOffered: null,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      expiresAtEstimate: null,
      checkoutSessionId: null,
      orderId: options.orderId,
      // What the middleware and the storefront sent, cleared from storage.
      afriex: null,
      return_url: null,
      sandbox: null,
    }

    return { id: sessionId, status: "pending", data }
  }

  /**
   * Turns an Afriex failure into something a storefront can act on. The
   * details go to the log; the shopper sees Afriex's own customer-safe message
   * where it gave one, or a plain one.
   */
  private toShopperError(error: unknown, sessionId: string): MedusaError {
    const failure = error as {
      name?: string
      message?: string
      statusCode?: number
      errorCode?: string
      details?: { friendlyMessage?: string; errorMessage?: string }
    }
    const status = typeof failure?.statusCode === "number" ? failure.statusCode : undefined

    this.logger_.error(
      `Afriex Checkout could not create a checkout session for ${sessionId}: ${
        status ? `HTTP ${status} ` : ""
      }${failure?.errorCode ? `${failure.errorCode} ` : ""}${
        failure?.details?.errorMessage ?? failure?.message ?? String(error)
      }`
    )

    if (failure?.name === "ValidationError") {
      // The SDK refused the request before sending it. That is the plugin's
      // bug to fix, not the shopper's.
      return checkoutFailure(
        CheckoutErrorCode.TEMPORARILY_UNAVAILABLE,
        "Payment could not be started. Please try again or choose another payment method."
      )
    }

    if (status === 401) {
      this.logger_.error(
        "Afriex rejected the API key for POST /checkout-session. The key is invalid or lacks the checkout-session permission; Afriex answers 401 for both."
      )
      return checkoutFailure(
        CheckoutErrorCode.TEMPORARILY_UNAVAILABLE,
        "Payments are temporarily unavailable. Please try again later or choose another payment method."
      )
    }

    if (status === 403 || status === 404) {
      // The endpoint is not there for this store: a route or version the
      // installed SDK no longer matches, or an account that may not use it.
      // Asking again will not change that, so the shopper is sent elsewhere
      // rather than told to try again.
      this.logger_.error(
        `Afriex answered HTTP ${status}${
          failure.errorCode ? ` ${failure.errorCode}` : ""
        } to POST /checkout-session, with an API key it accepted. Retrying will not help. Check that medusa-payment-afriex and @afriex/sdk are up to date, and that your Afriex account can create checkout sessions. Until it works, turn Afriex Checkout off in your regions.`
      )
      return checkoutRefusal(
        CheckoutErrorCode.NOT_CONFIGURED,
        "This payment option isn't available right now. Please choose another payment method."
      )
    }

    if (status === 409) {
      // Afriex already has a live session for this reference and does not
      // return its link, so this one cannot be recovered. Every attempt gets a
      // new Medusa session, and so a new reference: trying again works.
      this.logger_.error(
        `Afriex already has an active checkout session for reference ${sessionId}${
          failure.errorCode ? ` (${failure.errorCode})` : ""
        }. Its link is not in this answer, so it cannot be reused. The next attempt will use a new reference.`
      )
      return checkoutFailure(
        CheckoutErrorCode.TEMPORARILY_UNAVAILABLE,
        "Payment could not be started. Please try again."
      )
    }

    if (status === 422) {
      return checkoutRefusal(
        CheckoutErrorCode.UNAVAILABLE_FOR_CURRENCY,
        failure.details?.friendlyMessage ??
          "This payment option isn't available for your order. Please choose another payment method."
      )
    }

    if (status === 400) {
      return checkoutRefusal(
        CheckoutErrorCode.REFUSED,
        failure.details?.friendlyMessage ??
          "Afriex could not accept these payment details. Please check them or choose another payment method."
      )
    }

    return checkoutFailure(
      CheckoutErrorCode.TEMPORARILY_UNAVAILABLE,
      "Payment could not be started. Please try again."
    )
  }
}

/**
 * The middleware's instructions, read defensively. Anything missing or
 * malformed is a selection — the stage that never reaches Afriex.
 */
function readRequest(value: unknown): AfriexCheckoutRequest {
  if (!value || typeof value !== "object") {
    return { stage: "select" }
  }

  const request = value as Record<string, unknown>
  const customer = request.customer as AfriexCheckoutRequest["customer"] | undefined
  const validCustomer =
    !!customer &&
    typeof customer.name === "string" &&
    typeof customer.email === "string" &&
    typeof customer.phone === "string" &&
    typeof customer.countryCode === "string"
      ? customer
      : undefined

  return {
    stage: request.stage === "pay" ? "pay" : "select",
    customer: validCustomer,
    channels: Array.isArray(request.channels)
      ? request.channels.filter(isCheckoutChannel)
      : null,
    hide_bank: request.hide_bank === true,
    order_id: typeof request.order_id === "string" ? request.order_id : null,
    cart_id: typeof request.cart_id === "string" ? request.cart_id : null,
    payment_collection_id:
      typeof request.payment_collection_id === "string" ? request.payment_collection_id : null,
    purpose: request.purpose === "apply" ? "apply" : undefined,
  }
}

export default AfriexCheckoutService
