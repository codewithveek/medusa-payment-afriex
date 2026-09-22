import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Container, Copy, Heading, Text } from "@medusajs/ui"
import type { ReactNode } from "react"
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
  payment_collections?: {
    payments?: PaymentLike[]
    payment_sessions?: PaymentLike[]
  }[]
}

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
      <Text size="small" className="break-all">
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

/** What the plugin holds back or asks a person to look at, whichever the method. */
function HeldMoney({ data }: { data: AfriexSessionBase }) {
  const status = data.currentStatus
  const received = `${data.receivedAmount} ${data.receivedCurrency ?? data.expectedCurrency}`
  const extraDeposits = data.extraDeposits ?? []

  return (
    <>
      {status === AFRIEX_AMOUNT_MISMATCH ? (
        <Notice>
          Amount mismatch — received {received}, expected {data.expectedAmount}{" "}
          {data.expectedCurrency}. This order was not captured automatically and needs manual
          review.
        </Notice>
      ) : null}

      {status === AFRIEX_SETTLED_AFTER_CANCEL ? (
        <Notice>
          {received} arrived after this order was cancelled. It was not captured. Refund it from
          your Afriex dashboard.
        </Notice>
      ) : null}

      {status === AFRIEX_COLLECTION_AMOUNT_CHANGED ? (
        <Notice>
          {received} arrived for the order total the shopper was shown, {data.expectedAmount}{" "}
          {data.expectedCurrency}, but the order total has changed since. It was not captured and
          needs manual review.
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
                  {deposit.amount} {deposit.currency ?? data.expectedCurrency} ·{" "}
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
      <Row label="Expected">
        {data.expectedAmount} {data.expectedCurrency}
      </Row>
      {data.receivedAmount ? (
        <Row label="Received">
          {data.receivedAmount} {data.receivedCurrency ?? data.expectedCurrency}
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
          {data.chargedAmount ?? data.expectedAmount} {data.expectedCurrency}
        </Row>
        {channels ? <Row label="Options offered">{channels}</Row> : null}
        {data.paidChannel ? (
          <Row label="Paid with">{CHANNEL_LABEL[data.paidChannel] ?? data.paidChannel}</Row>
        ) : null}
        {data.receivedAmount ? (
          <Row label="Received">
            {data.receivedAmount} {data.receivedCurrency ?? data.expectedCurrency}
          </Row>
        ) : null}
        {data.afriexTransactionId ? <Row label="Transaction">{data.afriexTransactionId}</Row> : null}
        {data.checkoutSessionId ? <Row label="Afriex session">{data.checkoutSessionId}</Row> : null}
        {data.stage === "open" && expiry ? (
          <Row label={data.expiresAt ? "Link expires" : "Link expires (est.)"}>{expiry}</Row>
        ) : null}
        {data.paidViaReference ? (
          <Row label="Paid via">earlier link {data.paidViaReference}</Row>
        ) : null}
      </div>

      {data.stage === "selected" ? (
        <Notice tone="subtle">
          The shopper chose Afriex Checkout but has not opened a payment link yet.
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
        <Badge color={color} size="2xsmall">
          {status}
        </Badge>
      </div>

      {found.method === "checkout" ? (
        <CheckoutDetails data={found.data} />
      ) : (
        <BankTransferDetails data={found.data} />
      )}

      <HeldMoney data={found.data} />
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default AfriexOrderWidget
