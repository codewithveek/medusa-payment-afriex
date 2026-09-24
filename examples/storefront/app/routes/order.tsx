import { useEffect, useState } from "react"
import { Form, redirect, useNavigation, useRevalidator } from "react-router"
import type { Route } from "./+types/order"
import { afriexMethodOf, medusa, offeredMethods, type AfriexMethod } from "~/lib/medusa.server"
import { startPayment } from "~/lib/pay.server"
import { formatAmount } from "~/lib/format"

/**
 * The shape the plugin writes onto the payment session. It is redeclared here
 * because the published package ships JavaScript without type declarations.
 */
type AfriexInstructions = {
  bankName?: string
  accountNumber: string
  accountName?: string
  note: string
  expiresNote?: string
}

type AfriexSessionData = {
  currentStatus?: string
  instructions?: AfriexInstructions
  stage?: "selected" | "open"
  checkoutUrl?: string | null
  expiresAt?: string | null
  expiresAtEstimate?: string | null
  paidChannel?: string | null
  needsAttention?: string | null
  failureReason?: { message?: string; code?: string } | null
  transactions?: { status: string; otpRequired?: boolean }[]
}

/**
 * Where an order stands, in the order the page checks: the first that applies
 * decides what the shopper sees and can do.
 */
type PaymentState =
  | { kind: "cancelled" }
  | { kind: "paid"; channel?: string | null }
  | { kind: "held" }
  | { kind: "bank_transfer"; instructions: AfriexInstructions | null }
  | { kind: "not_started" }
  | { kind: "approve_on_phone"; url: string; otp: boolean }
  | { kind: "link_open"; url: string }
  | { kind: "failed_maybe_sent"; reason?: string }
  | { kind: "failed"; reason?: string }
  | { kind: "expired" }

const PAID_STATUSES = ["authorized", "captured", "completed"]
const HELD = ["AMOUNT_MISMATCH", "COLLECTION_AMOUNT_CHANGED", "SETTLED_AFTER_CANCEL"]
const FAILED = ["FAILED", "REJECTED", "CANCELLED"]

const CHANNEL_LABEL: Record<string, string> = {
  VIRTUAL_BANK_ACCOUNT: "bank transfer",
  MOBILE_MONEY: "mobile money",
  CARD: "card",
}

function stateOf(
  orderStatus: string | undefined,
  collectionStatus: string | undefined,
  method: AfriexMethod | undefined,
  data: AfriexSessionData
): PaymentState {
  if (orderStatus === "canceled") return { kind: "cancelled" }
  if (PAID_STATUSES.includes(collectionStatus ?? "") || data.currentStatus === "SUCCESS") {
    return { kind: "paid", channel: data.paidChannel }
  }
  if (HELD.includes(data.currentStatus ?? "")) return { kind: "held" }
  if (method === "bank_transfer") {
    return { kind: "bank_transfer", instructions: data.instructions ?? null }
  }
  if (method !== "checkout" || data.stage !== "open" || !data.checkoutUrl) {
    return { kind: "not_started" }
  }

  const status = data.currentStatus ?? "PENDING"
  if (FAILED.includes(status)) {
    return data.needsAttention === "possible_wrong_amount_transfer"
      ? { kind: "failed_maybe_sent", reason: data.failureReason?.message }
      : { kind: "failed", reason: data.failureReason?.message }
  }
  if (status === "CUSTOMER_ACTION_REQUIRED") {
    const latest = data.transactions?.at(-1)
    return { kind: "approve_on_phone", url: data.checkoutUrl, otp: !!latest?.otpRequired }
  }

  const expiry = Date.parse(data.expiresAt ?? data.expiresAtEstimate ?? "")
  if (Number.isFinite(expiry) && expiry < Date.now() && status === "PENDING") {
    return { kind: "expired" }
  }
  return { kind: "link_open", url: data.checkoutUrl }
}

export function meta() {
  return [{ title: "Your order — Afriex Example Store" }]
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { order } = await medusa.store.order.retrieve(params.orderId, {
    fields:
      "id,display_id,status,total,currency_code,region_id,*payment_collections,*payment_collections.payment_sessions",
  })

  const collections = order.payment_collections ?? []
  const collection =
    collections.find((c) => ["not_paid", "awaiting"].includes(c.status ?? "")) ?? collections[0]
  const session = collection?.payment_sessions?.find((s) => afriexMethodOf(s.provider_id))
  const method = afriexMethodOf(session?.provider_id)
  const url = new URL(request.url)

  return {
    orderId: order.id,
    displayId: order.display_id,
    total: order.total ?? 0,
    currencyCode: order.currency_code,
    method,
    state: stateOf(
      order.status,
      collection?.status,
      method,
      (session?.data ?? {}) as AfriexSessionData
    ),
    // Offered where the order was placed: what "pay another way" can switch to.
    offered: order.region_id ? await offeredMethods(order.region_id) : [],
    problem: url.searchParams.get("problem"),
    returned: url.searchParams.has("returned"),
  }
}

export async function action({ params, request }: Route.ActionArgs) {
  const form = await request.formData()
  const method: AfriexMethod = form.get("intent") === "bank" ? "bank_transfer" : "checkout"
  const result = await startPayment(params.orderId, method)

  switch (result.kind) {
    case "redirect":
      return redirect(result.url)
    case "in_progress":
      // A link that is still open is the one to use: never make a second.
      return result.url ? redirect(result.url) : { error: result.message }
    case "placed":
      return redirect(`/order/${params.orderId}`)
    default:
      return { error: result.message }
  }
}

export default function Order({ loaderData, actionData }: Route.ComponentProps) {
  const { displayId, total, currencyCode, state, offered, problem, returned } = loaderData
  const revalidator = useRevalidator()
  const navigation = useNavigation()
  const busy = navigation.state !== "idle"
  const sending = navigation.formData?.get("intent")
  const settled = state.kind === "paid" || state.kind === "cancelled"

  // Only Afriex's webhook moves an order to paid, so the page checks again on
  // its own instead of offering an "I have paid" button.
  useEffect(() => {
    if (settled) return
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate()
    }, 5000)
    return () => clearInterval(id)
  }, [settled, revalidator])

  const amount = formatAmount(total, currencyCode)
  const error = actionData?.error ?? problem
  const canSwitchToBank = offered.includes("bank_transfer")

  const PayButton = ({ label }: { label: string }) => (
    <Form method="post">
      <input type="hidden" name="intent" value="pay" />
      <button className="wide" disabled={busy}>
        {sending === "pay" ? "Opening the Afriex page…" : label}
      </button>
    </Form>
  )

  const BankInstead = () =>
    canSwitchToBank ? (
      <Form method="post">
        <input type="hidden" name="intent" value="bank" />
        <button className="wide ghost-button" disabled={busy}>
          {sending === "bank" ? "Getting your account details…" : "Pay by bank transfer instead"}
        </button>
      </Form>
    ) : null

  switch (state.kind) {
    case "cancelled":
      return (
        <section className="card">
          <h1>Order #{displayId} was cancelled</h1>
          <p className="muted">There is nothing to pay. If you think this is wrong, contact the store.</p>
        </section>
      )

    case "paid":
      return (
        <section className="card">
          <h1>Order #{displayId} is paid</h1>
          <p className="paid">
            Payment received{state.channel ? ` by ${CHANNEL_LABEL[state.channel] ?? state.channel}` : ""}.
            Thank you — we are getting your order ready.
          </p>
        </section>
      )

    case "held":
      return (
        <section className="card">
          <h1>We need to check your payment</h1>
          <p className="muted">
            A payment for order #{displayId} arrived, but it needs a person to look at it — usually
            because the amount was not quite what the order asks for. You don't need to do
            anything; the store will be in touch.
          </p>
        </section>
      )

    case "bank_transfer":
      return (
        <section className="card">
          <h1>Transfer to complete order #{displayId}</h1>
          <p className="muted">
            Your order is placed and waiting for payment. Send the exact amount to the account
            below.
          </p>

          {state.instructions ? (
            <>
              <div className="instructions">
                <div className="amount">{amount}</div>
                <dl>
                  {state.instructions.bankName ? (
                    <Pair label="Bank" value={state.instructions.bankName} />
                  ) : null}
                  <Pair label="Account number" value={state.instructions.accountNumber} copyable />
                  {state.instructions.accountName ? (
                    <Pair label="Account name" value={state.instructions.accountName} />
                  ) : null}
                </dl>
              </div>
              <p className="muted">{state.instructions.note}</p>
              {state.instructions.expiresNote ? (
                <p className="note">{state.instructions.expiresNote}</p>
              ) : null}
            </>
          ) : (
            <p className="error">
              No account details yet. That happens when Afriex could not create the account — the
              backend log says why.
            </p>
          )}

          <Waiting text="Waiting for Afriex to confirm your transfer. This page updates itself." />
        </section>
      )

    case "not_started":
      return (
        <section className="card">
          <h1>Finish paying for order #{displayId}</h1>
          <p className="muted">
            Your order is placed. Pay {amount} on a secure Afriex page, by mobile money or bank
            transfer.
          </p>
          {error ? <p className="error">{error}</p> : null}
          <div className="stack">
            <PayButton label={`Pay ${amount} with Afriex`} />
            <BankInstead />
          </div>
        </section>
      )

    case "approve_on_phone":
      return (
        <section className="card">
          <h1>{state.otp ? "Enter the code on the Afriex page" : "Approve the payment on your phone"}</h1>
          <p className="muted">
            {state.otp
              ? "Afriex sent a code to your phone. Enter it on the payment page to finish."
              : `Your mobile money provider has sent a prompt for ${amount}. Approve it on your phone to finish.`}
          </p>
          {/* With a code, the Afriex page is where the next step happens. With a
              phone prompt, the phone is — the page is only the fallback. */}
          <a className={state.otp ? "button wide" : "button wide ghost-button"} href={state.url}>
            {state.otp ? "Back to the payment page" : "No prompt? Back to the payment page"}
          </a>
          <Waiting
            text={
              state.otp
                ? "Waiting for the payment to go through. This page updates itself."
                : "Waiting for your approval. This page updates itself."
            }
          />
        </section>
      )

    case "link_open":
      return (
        <section className="card">
          <h1>{returned ? "Checking your payment" : `Pay for order #${displayId}`}</h1>
          <p className="muted">
            {returned
              ? "If you finished paying, this page shows it as soon as Afriex confirms — usually within a minute."
              : `Your payment page is ready. Pay ${amount} there, then you will come back here.`}
          </p>
          {error ? <p className="error">{error}</p> : null}
          {/* Back from Afriex, the shopper has most likely paid: going back to
              the page is the fallback, not the next step. */}
          <a className={returned ? "button wide ghost-button" : "button wide"} href={state.url}>
            {returned ? "Didn't finish? Back to the payment page" : "Continue to payment"}
          </a>
          <Waiting text="Waiting for Afriex to confirm your payment. This page updates itself." />
        </section>
      )

    case "failed_maybe_sent":
      return (
        <section className="card">
          <h1>We need to check your transfer</h1>
          <p className="muted">
            Afriex could not confirm your bank transfer for order #{displayId}. {state.reason}
          </p>
          <p className="note">
            If you already sent money from your bank, please don't pay again — the store will
            check and contact you.
          </p>
          <Waiting text="The store is checking. This page updates itself." />
        </section>
      )

    case "failed":
    case "expired":
      return (
        <section className="card">
          <h1>{state.kind === "expired" ? "Your payment link has expired" : "Your payment did not go through"}</h1>
          {state.kind === "failed" && state.reason ? (
            <p className="error">{state.reason}</p>
          ) : (
            <p className="muted">Nothing was taken. You can try again — your order is kept.</p>
          )}
          {error ? <p className="error">{error}</p> : null}
          <div className="stack">
            <PayButton label="Try again" />
            <BankInstead />
          </div>
        </section>
      )
  }
}

function Waiting({ text }: { text: string }) {
  return (
    <div className="status">
      <span className="pulse" />
      {text}
    </div>
  )
}

function Pair({ label, value, copyable }: { label: string; value: string; copyable?: boolean }) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="pair">
      <dt>{label}</dt>
      <dd>
        {value}
        {copyable ? (
          <button
            type="button"
            className="ghost"
            onClick={() => {
              void navigator.clipboard.writeText(value)
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        ) : null}
      </dd>
    </div>
  )
}
