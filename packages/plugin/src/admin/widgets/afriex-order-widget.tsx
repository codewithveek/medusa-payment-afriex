import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import { AFRIEX_AMOUNT_MISMATCH } from "../../lib/constants"
import type { AfriexSessionData } from "../../lib/types"

type PaymentLike = { provider_id?: string; data?: Record<string, unknown> }

type OrderLike = {
  payment_collections?: {
    payments?: PaymentLike[]
    payment_sessions?: PaymentLike[]
  }[]
}

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
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
  FAILED: "red",
  REJECTED: "red",
  CANCELLED: "red",
}

/**
 * A captured order carries the Afriex data on its payment. An order still
 * waiting for money — or one whose deposit did not match and so never became
 * a payment — only has it on the session. The session is the live record the
 * webhook writes to, so it is preferred when both exist.
 */
function findAfriexPayment(order: OrderLike): AfriexSessionData | undefined {
  for (const collection of order.payment_collections ?? []) {
    const candidates = [
      ...(collection.payment_sessions ?? []),
      ...(collection.payments ?? []),
    ]

    for (const candidate of candidates) {
      if (candidate.provider_id?.includes("afriex") && candidate.data) {
        return candidate.data as unknown as AfriexSessionData
      }
    }
  }
  return undefined
}

const AfriexOrderWidget = ({ data }: { data: OrderLike }) => {
  const afriex = findAfriexPayment(data)

  if (!afriex) {
    return null
  }

  const status = afriex.currentStatus ?? "PENDING"
  const extraDeposits = afriex.extraDeposits ?? []

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <Heading level="h2">Afriex Payment</Heading>
        <Badge color={STATUS_COLOR[status] ?? "grey"} size="2xsmall">
          {status}
        </Badge>
      </div>

      <div className="text-ui-fg-subtle grid grid-cols-2 gap-x-4 gap-y-2 px-6 py-4 txt-small">
        <Text size="small" weight="plus">
          Reference
        </Text>
        <Text size="small">{afriex.reference}</Text>

        <Text size="small" weight="plus">
          Method
        </Text>
        <Text size="small">
          {afriex.collectionMethod === "pool"
            ? "Pool account"
            : "Dedicated virtual account"}
        </Text>

        <Text size="small" weight="plus">
          Account
        </Text>
        <Text size="small">
          {afriex.accountNumber}
          {afriex.institutionName ? ` · ${afriex.institutionName}` : ""}
        </Text>

        <Text size="small" weight="plus">
          Expected
        </Text>
        <Text size="small">
          {afriex.expectedAmount} {afriex.expectedCurrency}
        </Text>

        {afriex.receivedAmount ? (
          <>
            <Text size="small" weight="plus">
              Received
            </Text>
            <Text size="small">
              {afriex.receivedAmount}{" "}
              {afriex.receivedCurrency ?? afriex.expectedCurrency}
            </Text>
          </>
        ) : null}

        {afriex.afriexTransactionId ? (
          <>
            <Text size="small" weight="plus">
              Transaction
            </Text>
            <Text size="small">{afriex.afriexTransactionId}</Text>
          </>
        ) : null}
      </div>

      {status === AFRIEX_AMOUNT_MISMATCH ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            Amount mismatch — received {afriex.receivedAmount}{" "}
            {afriex.receivedCurrency ?? afriex.expectedCurrency}, expected{" "}
            {afriex.expectedAmount} {afriex.expectedCurrency}. This order was not
            captured automatically and needs manual review.
          </Text>
        </div>
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
              <li key={deposit.transactionId}>
                <Text size="small">
                  {deposit.amount} {deposit.currency ?? afriex.expectedCurrency} ·{" "}
                  {deposit.transactionId}
                </Text>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default AfriexOrderWidget
