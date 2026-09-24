import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Button, Container, Copy, Heading, Text, toast, usePrompt } from "@medusajs/ui"
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { call, money, post } from "../lib/api"
import { applyLatePayment, describeAccept, type Prompt } from "../lib/settle"
import {
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
  AFRIEX_SETTLED_AFTER_CANCEL,
  afriexMethodOf,
} from "../../lib/constants"
import type {
  AfriexBankTransferSessionData,
  AfriexCheckoutSessionData,
  AfriexSessionBase,
} from "../../lib/types"

type PaymentLike = { provider_id?: string; data?: Record<string, unknown> }

type OrderLike = {
  id?: string
  payment_collections?: {
    payments?: PaymentLike[]
    payment_sessions?: PaymentLike[]
  }[]
}

/** What `GET /admin/afriex/orders/:id/payment` answers, which is what the buttons act on. */
type OrderPayment = {
  sessions: {
    id: string
    method: "bank_transfer" | "checkout"
    status: string
    data: AfriexSessionBase
  }[]
  references: {
    reference: string
    late_payments: {
      transaction_id: string
      amount: string
      currency?: string | null
      status: "held" | "applied" | "refunded"
    }[]
  }[]
}

const HELD_STATUSES = [
  AFRIEX_AMOUNT_MISMATCH,
  AFRIEX_SETTLED_AFTER_CANCEL,
  AFRIEX_COLLECTION_AMOUNT_CHANGED,
]

type Found =
  | { method: "bank_transfer"; data: AfriexBankTransferSessionData }
  | { method: "checkout"; data: AfriexCheckoutSessionData }

type Color = "green" | "orange" | "red" | "grey"

const STATUS_COLOR: Record<string, Color> = {
  SUCCESS: "green",
  PENDING: "grey",
  PROCESSING: "grey",
  SCHEDULED: "grey",
  RETRY: "orange",
  IN_REVIEW: "orange",
  CUSTOMER_ACTION_REQUIRED: "orange",
  UNKNOWN: "orange",
  DISPUTED: "orange",
  DISPUTE_EVIDENCE_SUBMITTED: "orange",
  DISPUTE_RESOLVED: "orange",
  DISPUTE_WON: "orange",
  DISPUTE_LOST: "red",
  REFUNDED: "orange",
  [AFRIEX_AMOUNT_MISMATCH]: "red",
  [AFRIEX_SETTLED_AFTER_CANCEL]: "red",
  [AFRIEX_COLLECTION_AMOUNT_CHANGED]: "red",
  FAILED: "red",
  REJECTED: "red",
  CANCELLED: "red",
}

/** What the badge says. Afriex's raw status is still shown to anyone who hovers. */
const STATUS_LABEL: Record<string, string> = {
  SUCCESS: "Paid",
  PENDING: "Waiting for payment",
  PROCESSING: "Processing",
  SCHEDULED: "Scheduled",
  RETRY: "Retrying",
  IN_REVIEW: "In review at Afriex",
  CUSTOMER_ACTION_REQUIRED: "Waiting on the shopper",
  UNKNOWN: "Unknown",
  DISPUTED: "Disputed",
  DISPUTE_EVIDENCE_SUBMITTED: "Dispute: evidence sent",
  DISPUTE_RESOLVED: "Dispute resolved",
  DISPUTE_WON: "Dispute won",
  DISPUTE_LOST: "Dispute lost",
  REFUNDED: "Refunded",
  [AFRIEX_AMOUNT_MISMATCH]: "Amount did not match",
  [AFRIEX_SETTLED_AFTER_CANCEL]: "Paid after cancel",
  [AFRIEX_COLLECTION_AMOUNT_CHANGED]: "Order total changed",
  FAILED: "Failed",
  REJECTED: "Rejected",
  CANCELLED: "Cancelled",
}

const CHANNEL_LABEL: Record<string, string> = {
  VIRTUAL_BANK_ACCOUNT: "Bank transfer",
  MOBILE_MONEY: "Mobile money",
  CARD: "Card",
}

/**
 * A captured order carries the Afriex data on its payment. An order still
 * waiting for money — or one whose deposit did not match and so never became
 * a payment — only has it on the session. The session is the live record the
 * webhook writes to, so it is preferred when both exist. Which method it is
 * comes from the provider id, never from the data.
 */
function findAfriexPayment(order: OrderLike): Found | undefined {
  for (const collection of order.payment_collections ?? []) {
    const candidates = [
      ...(collection.payment_sessions ?? []),
      ...(collection.payments ?? []),
    ]

    for (const candidate of candidates) {
      const method = afriexMethodOf(candidate.provider_id)
      if (method && candidate.data) {
        return { method, data: candidate.data } as unknown as Found
      }
    }
  }
  return undefined
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <Text size="small" weight="plus">
        {label}
      </Text>
      {/* Wraps at spaces, and breaks only a token too long to fit, like a reference. */}
      <Text size="small" className="[overflow-wrap:anywhere]">
        {children}
      </Text>
    </>
  )
}

function Notice({ tone = "error", children }: { tone?: "error" | "subtle"; children: ReactNode }) {
  return (
    <div className="px-6 py-4">
      <Text size="small" className={tone === "error" ? "text-ui-fg-error" : "text-ui-fg-subtle"}>
        {children}
      </Text>
    </div>
  )
}

function formatTime(value: string | null | undefined): string | undefined {
  if (!value) {
    return undefined
  }
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

/**
 * When a person settled this payment rather than the webhook, say so — and, for
 * a short payment accepted in full, by how much. That is the first thing anyone
 * reconciling the books later will ask.
 */
function SettledByHand({ data }: { data: AfriexSessionBase }) {
  if (!data.resolvedAt || data.currentStatus !== "SUCCESS") {
    return null
  }

  const charged =
    (data as { chargedAmount?: string | null }).chargedAmount ?? data.expectedAmount
  const received = Number(data.receivedAmount)
  const short = Number(charged) - received
  const currency = data.receivedCurrency ?? data.expectedCurrency

  return (
    <Notice tone="subtle">
      Settled by an admin on {formatTime(data.resolvedAt) ?? data.resolvedAt}
      {Number.isFinite(short) && short > 0
        ? `, accepting ${money(received, currency)} as payment in full — ${money(short, currency)} was not collected.`
        : "."}
    </Notice>
  )
}

/** What the plugin holds back or asks a person to look at, whichever the method. */
function HeldMoney({ data }: { data: AfriexSessionBase }) {
  const status = data.currentStatus
  const received = money(data.receivedAmount, data.receivedCurrency ?? data.expectedCurrency)
  const expected = money(data.expectedAmount, data.expectedCurrency)
  const extraDeposits = data.extraDeposits ?? []

  return (
    <>
      {status === AFRIEX_AMOUNT_MISMATCH ? (
        <Notice>
          {received} arrived, but this order asks for {expected}. It was not captured — decide
          below whether to accept it or refund it.
        </Notice>
      ) : null}

      {status === AFRIEX_SETTLED_AFTER_CANCEL ? (
        <Notice>
          {received} arrived after this order was cancelled. It was not captured — refund it from
          your Afriex dashboard, and mark it below once you have.
        </Notice>
      ) : null}

      {status === AFRIEX_COLLECTION_AMOUNT_CHANGED ? (
        <Notice>
          {received} arrived for the total the shopper was shown, {expected}, but the order total
          has changed since. It was not captured — decide below what happens to it.
        </Notice>
      ) : null}

      {data.needsAttention === "possible_wrong_amount_transfer" ? (
        <Notice>
          A bank transfer on the Afriex page failed. The shopper may have sent a different amount;
          check your Afriex dashboard before asking them to pay again.
        </Notice>
      ) : null}

      {extraDeposits.length ? (
        <div className="px-6 py-4">
          <Text size="small" weight="plus" className="text-ui-fg-error">
            {extraDeposits.length === 1
              ? "One additional deposit needs a refund"
              : `${extraDeposits.length} additional deposits need a refund`}
          </Text>
          <ul className="mt-2 space-y-1">
            {extraDeposits.map((deposit) => (
              <li key={`${deposit.transactionId}:${deposit.reason ?? ""}`}>
                <Text size="small">
                  {money(deposit.amount, deposit.currency ?? data.expectedCurrency)} ·{" "}
                  {deposit.transactionId}
                  {deposit.reason === "excess" ? " · paid over the total" : ""}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

function BankTransferDetails({ data }: { data: AfriexBankTransferSessionData }) {
  return (
    <div className="text-ui-fg-subtle grid grid-cols-2 gap-x-4 gap-y-2 px-6 py-4 txt-small">
      <Row label="Reference">{data.reference}</Row>
      <Row label="Method">Bank transfer · dedicated virtual account</Row>
      <Row label="Account">
        {data.accountNumber}
        {data.institutionName ? ` · ${data.institutionName}` : ""}
      </Row>
      <Row label="Expected">{money(data.expectedAmount, data.expectedCurrency)}</Row>
      {data.receivedAmount ? (
        <Row label="Received">
          {money(data.receivedAmount, data.receivedCurrency ?? data.expectedCurrency)}
        </Row>
      ) : null}
      {data.afriexTransactionId ? <Row label="Transaction">{data.afriexTransactionId}</Row> : null}
      {data.paidViaReference ? (
        <Row label="Paid via">earlier account {data.paidViaReference}</Row>
      ) : null}
    </div>
  )
}

function CheckoutDetails({ data }: { data: AfriexCheckoutSessionData }) {
  const expiresAt = data.expiresAt ?? data.expiresAtEstimate
  const expiry = formatTime(expiresAt)
  const expired = Date.parse(expiresAt ?? "") < Date.now()
  const linkOpen =
    data.stage === "open" && !!data.checkoutUrl && data.currentStatus !== "SUCCESS" && !expired
  const offered = data.channelsOffered ?? data.channelsRequested
  const channels = offered?.length
    ? offered.map((channel) => CHANNEL_LABEL[channel] ?? channel).join(", ")
    : undefined

  return (
    <>
      <div className="text-ui-fg-subtle grid grid-cols-2 gap-x-4 gap-y-2 px-6 py-4 txt-small">
        <Row label="Method">Afriex Checkout (hosted page)</Row>
        <Row label="Reference">{data.merchantReference ?? data.reference}</Row>
        <Row label="Charged">
          {money(data.chargedAmount ?? data.expectedAmount, data.expectedCurrency)}
        </Row>
        {channels ? <Row label="Options offered">{channels}</Row> : null}
        {data.paidChannel ? (
          <Row label="Paid with">{CHANNEL_LABEL[data.paidChannel] ?? data.paidChannel}</Row>
        ) : null}
        {data.receivedAmount ? (
          <Row label="Received">
            {money(data.receivedAmount, data.receivedCurrency ?? data.expectedCurrency)}
          </Row>
        ) : null}
        {data.afriexTransactionId ? <Row label="Transaction">{data.afriexTransactionId}</Row> : null}
        {data.checkoutSessionId ? <Row label="Afriex session">{data.checkoutSessionId}</Row> : null}
        {/* Once money has moved, when the link would have expired no longer matters. */}
        {data.stage === "open" && expiry && !data.afriexTransactionId ? (
          <Row
            label={`${expired ? "Link expired" : "Link expires"}${data.expiresAt ? "" : " (est.)"}`}
          >
            {expiry}
          </Row>
        ) : null}
        {data.paidViaReference ? (
          <Row label="Paid via">earlier link {data.paidViaReference}</Row>
        ) : null}
      </div>

      {data.stage === "selected" && !data.afriexTransactionId ? (
        <Notice tone="subtle">
          The shopper chose Afriex Checkout but has not opened a payment link yet.
        </Notice>
      ) : null}

      {data.stage === "open" && expired && !data.afriexTransactionId && data.currentStatus !== "SUCCESS" ? (
        <Notice tone="subtle">
          The payment link has expired. The shopper can get a new one by choosing to pay again from
          their order page.
        </Notice>
      ) : null}

      {linkOpen ? (
        <div className="flex items-center justify-between gap-x-2 px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Payment link — send it to the shopper if they lost it.
          </Text>
          <Copy content={data.checkoutUrl!} />
        </div>
      ) : null}

      {data.failureReason && data.currentStatus !== "SUCCESS" ? (
        <Notice>
          Last attempt failed{data.failureReason.message ? `: ${data.failureReason.message}` : "."}
          {data.failureReason.code ? ` (${data.failureReason.code})` : ""}
        </Notice>
      ) : null}

      {data.transactions && data.transactions.length > 1 ? (
        <div className="px-6 py-4">
          <Text size="small" weight="plus">
            Attempts
          </Text>
          <ul className="mt-2 space-y-1">
            {data.transactions.map((transaction) => (
              <li key={`${transaction.transactionId}:${transaction.status}`}>
                <Text size="small" className="text-ui-fg-subtle">
                  {formatTime(transaction.at) ?? transaction.at} ·{" "}
                  {transaction.channel
                    ? `${CHANNEL_LABEL[transaction.channel] ?? transaction.channel} · `
                    : ""}
                  {transaction.status} · {transaction.transactionId}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  )
}

/**
 * What a person can do about money the plugin held back. Medusa's own "Mark as
 * paid" cannot settle these orders, so this is the only way short of the API.
 */
function Settle({ orderId }: { orderId: string }) {
  const [payment, setPayment] = useState<OrderPayment | null>(null)
  const [busy, setBusy] = useState(false)
  const prompt = usePrompt()

  const load = useCallback(async () => {
    const { status, body } = await call<OrderPayment>(`/admin/afriex/orders/${orderId}/payment`)
    setPayment(status === 200 ? body : null)
  }, [orderId])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (
    action: () => Promise<{ status: number; body: any }>,
    success: string
  ): Promise<void> => {
    setBusy(true)
    try {
      const { status, body } = await action()
      if (status === 200) {
        toast.success(success)
        await load()
      } else if (status !== -1) {
        // -1 is a person cancelling a confirmation: nothing to report.
        toast.error(body?.message ?? "That did not work.")
      }
    } finally {
      setBusy(false)
    }
  }

  if (!payment) {
    return null
  }

  const holding = payment.sessions.filter((session) =>
    HELD_STATUSES.includes(String(session.data?.currentStatus))
  )
  const held = payment.references.flatMap((reference) =>
    reference.late_payments
      .filter((late) => late.status === "held")
      .map((late) => ({ reference: reference.reference, ...late }))
  )

  if (!holding.length && !held.length) {
    return null
  }

  const accept = async (session: OrderPayment["sessions"][number]) => {
    const received = session.data?.receivedAmount
    const currency = session.data?.receivedCurrency ?? session.data?.expectedCurrency
    const expected =
      (session.data as { chargedAmount?: string | null })?.chargedAmount ??
      session.data?.expectedAmount
    const confirmed = await prompt({
      title: "Accept this as payment in full?",
      description: describeAccept(received, expected, currency),
      confirmText: "Accept as payment",
      cancelText: "Cancel",
      variant: "confirmation",
    })
    if (!confirmed) {
      return
    }

    await act(
      () =>
        post(`/admin/afriex/sessions/${session.id}/resolve`, {
          action: "accept",
          received_amount: received,
        }),
      "Accepted as payment"
    )
  }

  const refund = async (session: OrderPayment["sessions"][number]) => {
    const confirmed = await prompt({
      title: "Mark this money for refund?",
      description:
        "The order stays unpaid, and the shopper can pay again. The refund itself is made from your Afriex dashboard — this only records that it is owed.",
      confirmText: "Mark for refund",
      cancelText: "Cancel",
      variant: "danger",
    })
    if (!confirmed) {
      return
    }

    await act(
      () => post(`/admin/afriex/sessions/${session.id}/resolve`, { action: "refund" }),
      "Recorded as money to refund"
    )
  }

  return (
    <div className="flex flex-col gap-y-4 px-6 py-4">
      {holding.map((session) => (
        <div key={session.id} className="flex flex-col gap-y-3">
          <Text size="small" weight="plus">
            {session.data?.currentStatus === AFRIEX_SETTLED_AFTER_CANCEL
              ? "Once you have refunded it"
              : "What should happen to this money?"}
          </Text>
          <div className="flex flex-wrap gap-2">
            {session.data?.currentStatus === AFRIEX_SETTLED_AFTER_CANCEL ? null : (
              <Button size="small" variant="secondary" disabled={busy} onClick={() => void accept(session)}>
                Accept as payment
              </Button>
            )}
            <Button size="small" variant="secondary" disabled={busy} onClick={() => void refund(session)}>
              Mark for refund
            </Button>
          </div>
        </div>
      ))}

      {held.map((late) => (
        <div key={`${late.reference}:${late.transaction_id}`} className="flex flex-col gap-y-3">
          <div>
            <Text size="small" weight="plus">
              {money(late.amount, late.currency)} arrived through an earlier payment
            </Text>
            <Text size="small" className="text-ui-fg-subtle [overflow-wrap:anywhere]">
              That payment ({late.reference}) was replaced before the money came, so it was held
              for you to apply.
            </Text>
          </div>
          <div>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void act(
                  async () =>
                    (await applyLatePayment(prompt as unknown as Prompt, late)) ?? {
                      status: -1,
                      body: null,
                    },
                  "Applied to this order"
                )
              }
            >
              Apply to this order
            </Button>
          </div>
        </div>
      ))}
    </div>
  )
}

const AfriexOrderWidget = ({ data }: { data: OrderLike }) => {
  const found = findAfriexPayment(data)

  if (!found) {
    return null
  }

  const status = found.data.currentStatus ?? "PENDING"
  // On the hosted page this is the shopper approving a mobile-money prompt.
  const color =
    found.method === "checkout" && status === "CUSTOMER_ACTION_REQUIRED"
      ? "grey"
      : STATUS_COLOR[status] ?? "grey"

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Afriex Payment</Heading>
        <span title={status}>
          <Badge color={color} size="2xsmall">
            {STATUS_LABEL[status] ?? status}
          </Badge>
        </span>
      </div>

      {found.method === "checkout" ? (
        <CheckoutDetails data={found.data} />
      ) : (
        <BankTransferDetails data={found.data} />
      )}

      <HeldMoney data={found.data} />

      <SettledByHand data={found.data} />

      {data.id ? <Settle orderId={data.id} /> : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default AfriexOrderWidget
