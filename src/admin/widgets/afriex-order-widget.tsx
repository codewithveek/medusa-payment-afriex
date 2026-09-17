import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import { AFRIEX_AMOUNT_MISMATCH } from "../../lib/constants"
import type { AfriexSessionData } from "../../lib/types"

type OrderLike = {
  payment_collections?: {
    payments?: { provider_id?: string; data?: Record<string, unknown> }[]
  }[]
}

const STATUS_COLOR: Record<string, "green" | "orange" | "red" | "grey"> = {
  COMPLETED: "green",
  SUCCESS: "green",
  PENDING: "grey",
  PROCESSING: "grey",
  RETRY: "orange",
  IN_REVIEW: "orange",
  [AFRIEX_AMOUNT_MISMATCH]: "red",
  FAILED: "red",
  REJECTED: "red",
}

function findAfriexPayment(order: OrderLike): AfriexSessionData | undefined {
  for (const collection of order.payment_collections ?? []) {
    for (const payment of collection.payments ?? []) {
      if (payment.provider_id?.includes("afriex") && payment.data) {
        return payment.data as unknown as AfriexSessionData
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
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "order.details.side.after",
})

export default AfriexOrderWidget
