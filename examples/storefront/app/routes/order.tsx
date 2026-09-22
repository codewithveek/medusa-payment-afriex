import { useEffect, useState } from "react"
import { useRevalidator } from "react-router"
import type { Route } from "./+types/order"
import { AFRIEX_PROVIDER_ID, medusa } from "~/lib/medusa.server"
import { formatAmount } from "~/lib/format"

/**
 * The shape the plugin writes onto the payment session. It is redeclared here
 * because the published package ships JavaScript without type declarations —
 * if that changes, import `AfriexPaymentInstructions` from the plugin instead.
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
  receivedAmount?: string
  receivedCurrency?: string
}

const PAID_STATUSES = ["authorized", "captured", "completed"]

export function meta() {
  return [{ title: "Complete your transfer — Afriex Example Store" }]
}

export async function loader({ params }: Route.LoaderArgs) {
  const { order } = await medusa.store.order.retrieve(params.orderId, {
    fields: "*payment_collections,*payment_collections.payment_sessions",
  })

  const collection = order.payment_collections?.[0]
  const session = collection?.payment_sessions?.find(
    (candidate) => candidate.provider_id === AFRIEX_PROVIDER_ID
  )
  const data = (session?.data ?? {}) as AfriexSessionData

  return {
    displayId: order.display_id,
    total: order.total ?? 0,
    currencyCode: order.currency_code,
    // `currentStatus` is the plugin's own field; the collection status is
    // Medusa's. Either flipping means the webhook landed.
    paid:
      PAID_STATUSES.includes(collection?.status ?? "") ||
      (data.currentStatus ?? "").toUpperCase() === "SUCCESS",
    amountMismatch: (data.currentStatus ?? "") === "AMOUNT_MISMATCH",
    instructions: data.instructions ?? null,
  }
}

export default function Order({ loaderData }: Route.ComponentProps) {
  const { displayId, total, currencyCode, paid, amountMismatch, instructions } =
    loaderData
  const revalidator = useRevalidator()

  // The webhook is the only thing that can move this order to paid, so the
  // page polls instead of offering an "I have paid" button.
  useEffect(() => {
    if (paid) return
    const id = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate()
    }, 5000)
    return () => clearInterval(id)
  }, [paid, revalidator])

  if (paid) {
    return (
      <section className="card">
        <h1>Order #{displayId} is paid</h1>
        <p className="paid">
          Afriex confirmed your transfer and the order has been completed.
        </p>
      </section>
    )
  }

  return (
    <section className="card">
      <h1>Transfer to complete order #{displayId}</h1>
      <p className="muted">
        Your order is placed and waiting for payment. Send the exact amount to
        the account below.
      </p>

      {instructions ? (
        <>
          <div className="instructions">
            <div className="amount">{formatAmount(total, currencyCode)}</div>
            <dl>
              {instructions.bankName ? (
                <Pair label="Bank" value={instructions.bankName} />
              ) : null}
              <Pair label="Account number" value={instructions.accountNumber} copyable />
              {instructions.accountName ? (
                <Pair label="Account name" value={instructions.accountName} />
              ) : null}
            </dl>
          </div>

          <p className="note">{instructions.note}</p>
          {instructions.expiresNote ? (
            <p className="note">{instructions.expiresNote}</p>
          ) : null}
        </>
      ) : (
        <p className="error">
          No Afriex payment session on this order. That happens when the
          provider could not mint a collection account — check the backend logs.
        </p>
      )}

      {amountMismatch ? (
        <p className="note">
          A transfer arrived but the amount did not match this order. It is held
          for review — someone will be in touch.
        </p>
      ) : null}

      <div className="status">
        <span className="pulse" />
        Waiting for Afriex to confirm your transfer. This page updates itself.
      </div>
    </section>
  )
}

function Pair({
  label,
  value,
  copyable,
}: {
  label: string
  value: string
  copyable?: boolean
}) {
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
