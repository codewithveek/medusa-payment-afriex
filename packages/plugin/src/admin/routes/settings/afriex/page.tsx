import { defineRouteConfig } from "@medusajs/admin-sdk"
import {
  Badge,
  Button,
  Checkbox,
  Container,
  Copy,
  Heading,
  Switch,
  Table,
  Text,
  toast,
  usePrompt,
} from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"
import { call, money, post } from "../../../lib/api"

type Method = {
  provider_id: string
  method: "bank_transfer" | "checkout"
  regions_on: string[]
  waiting: number
  waiting_without_link: number
}

type Region = { id: string; name: string; currency_code: string; methods: string[] }

type SetupCheck = { id: string; level: "ok" | "warn" | "advice"; message: string }

type Attention =
  | {
      kind: "session"
      payment_session_id: string
      order_id: string | null
      display_id: number | null
      status: string
      expected: string | null
      received: string | null
      currency: string | null
      extra_deposits: number
    }
  | {
      kind: "late_payment"
      reference: string
      transaction_id: string
      amount: string
      currency: string | null
      order_id: string | null
      display_id: number | null
    }

type Overview = {
  webhook_path: string
  last_webhook: { at: string; event_id: string } | null
  setup: SetupCheck[]
  regions: Region[]
  methods: Method[]
  settings: {
    checkoutChannels: string[] | null
    hideBankChannelWhereBankTransfer: boolean
    pausedRegions: Record<string, string[]> | null
  }
  attention: Attention[]
}

const METHOD_LABEL: Record<Method["method"], string> = {
  bank_transfer: "Bank transfer",
  checkout: "Afriex Checkout",
}

const CHANNELS: { value: string; label: string; note?: string }[] = [
  { value: "VIRTUAL_BANK_ACCOUNT", label: "Bank transfer" },
  { value: "MOBILE_MONEY", label: "Mobile money" },
  { value: "CARD", label: "Card", note: "not sent until the Afriex SDK accepts it" },
]

const HELD_LABEL: Record<string, string> = {
  AMOUNT_MISMATCH: "Amount did not match",
  SETTLED_AFTER_CANCEL: "Paid after the order was cancelled",
  COLLECTION_AMOUNT_CHANGED: "Order total changed after the shopper was asked to pay",
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">{title}</Heading>
      </div>
      {children}
    </Container>
  )
}

const AfriexSettingsPage = () => {
  const [overview, setOverview] = useState<Overview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const prompt = usePrompt()

  const load = useCallback(async () => {
    const { status, body } = await call<Overview & { message?: string }>("/admin/afriex/overview")
    if (status === 200) {
      setOverview(body)
      setError(null)
    } else {
      setError(body?.message ?? "The Afriex overview could not be loaded.")
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  /** Runs an action, shows what came back, and refreshes the page's data. */
  const run = async (
    key: string,
    action: () => Promise<{ status: number; body: any }>,
    success: string,
    confirmEmpty?: () => Promise<{ status: number; body: any }>
  ) => {
    setBusy(key)
    try {
      let result = await action()

      if (result.status === 409 && result.body?.code === "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS" && confirmEmpty) {
        const confirmed = await prompt({
          title: "That leaves shoppers with no way to pay",
          description: `${result.body.message} Shoppers there won't be able to pay for an order until you turn a payment method back on.`,
          confirmText: "Do it anyway",
          cancelText: "Keep it on",
        })
        if (!confirmed) {
          return
        }
        result = await confirmEmpty()
      }

      if (result.status === 200) {
        if (result.body?.regions) {
          setOverview(result.body as Overview)
        } else {
          await load()
        }
        toast.success(success)
      } else {
        toast.error(result.body?.message ?? "That did not work.")
      }
    } finally {
      setBusy(null)
    }
  }

  if (error) {
    return (
      <Section title="Afriex">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            {error}
          </Text>
        </div>
      </Section>
    )
  }

  if (!overview) {
    return (
      <Section title="Afriex">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Loading…
          </Text>
        </div>
      </Section>
    )
  }

  const { regions, methods, settings, attention, setup } = overview
  const channels = settings.checkoutChannels
  const paused = settings.pausedRegions ?? {}

  const toggleRegion = (region: Region, method: Method, enabled: boolean) =>
    run(
      `${region.id}:${method.provider_id}`,
      () =>
        post(`/admin/afriex/regions/${region.id}/methods`, {
          provider_id: method.provider_id,
          enabled,
        }),
      `${METHOD_LABEL[method.method]} turned ${enabled ? "on" : "off"} in ${region.name}`,
      () =>
        post(`/admin/afriex/regions/${region.id}/methods`, {
          provider_id: method.provider_id,
          enabled,
          confirm_empty: true,
        })
    )

  const toggleEverywhere = async (method: Method, enabled: boolean) => {
    if (!enabled) {
      const waiting = method.waiting
        ? ` ${method.waiting} ${method.waiting === 1 ? "payment is" : "payments are"} still waiting for money; ${method.waiting === 1 ? "it" : "they"} will still be marked paid when it arrives.`
        : ""
      const confirmed = await prompt({
        title: `Turn ${METHOD_LABEL[method.method]} off everywhere?`,
        description: `No shopper will be offered it in any region.${waiting} You can turn it back on, and it returns to exactly the regions it is on now.`,
        confirmText: "Turn off everywhere",
        cancelText: "Cancel",
      })
      if (!confirmed) {
        return
      }
    }

    await run(
      `everywhere:${method.method}`,
      () => post(`/admin/afriex/methods/${method.method}/everywhere`, { enabled }),
      enabled
        ? `${METHOD_LABEL[method.method]} is back on where it was`
        : `${METHOD_LABEL[method.method]} turned off everywhere`,
      () =>
        post(`/admin/afriex/methods/${method.method}/everywhere`, { enabled, confirm_empty: true })
    )
  }

  const saveChannels = (value: string, checked: boolean) => {
    const current = channels ?? CHANNELS.map((channel) => channel.value)
    const next = checked ? [...new Set([...current, value])] : current.filter((c) => c !== value)

    if (!next.length) {
      toast.error("Leave at least one option, or shoppers cannot pay on the Afriex page.")
      return
    }

    return run(
      `channel:${value}`,
      () => post("/admin/afriex/settings", { checkout_channels: next }),
      "Saved"
    )
  }

  const applyLate = async (item: Extract<Attention, { kind: "late_payment" }>) => {
    const confirmed = await prompt({
      title: "Apply this payment to its order?",
      description: `${money(item.amount, item.currency)} arrived for ${item.reference}. It will be recorded on the order's current Afriex payment and captured.`,
      confirmText: "Apply it",
      cancelText: "Cancel",
    })
    if (!confirmed) {
      return
    }

    await run(
      `apply:${item.transaction_id}`,
      () =>
        post(`/admin/afriex/references/${item.reference}/apply`, {
          transaction_id: item.transaction_id,
        }),
      "Applied to the order"
    )
  }

  return (
    <div className="flex flex-col gap-y-3">
      <Section title="Setup">
        <div className="flex items-center justify-between gap-x-4 px-6 py-4">
          <div>
            <Text size="small" weight="plus">
              Webhook URL
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Register this path on your server with Afriex: {overview.webhook_path}
            </Text>
          </div>
          <Copy content={overview.webhook_path} />
        </div>
        {setup.map((check) => (
          <div key={check.id} className="flex items-start gap-x-3 px-6 py-3">
            <Badge
              size="2xsmall"
              color={check.level === "ok" ? "green" : check.level === "warn" ? "orange" : "grey"}
            >
              {check.level === "ok" ? "OK" : check.level === "warn" ? "Check" : "Note"}
            </Badge>
            <Text size="small" className="text-ui-fg-subtle">
              {check.message}
            </Text>
          </div>
        ))}
      </Section>

      <Section title="Payment methods">
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            Which Afriex methods shoppers are offered, region by region. Turning one off stops new
            payments; money already on its way still marks its order paid.
          </Text>
        </div>
        <Table>
          <Table.Header>
            <Table.Row>
              <Table.HeaderCell>Region</Table.HeaderCell>
              {methods.map((method) => (
                <Table.HeaderCell key={method.provider_id}>
                  {METHOD_LABEL[method.method]}
                </Table.HeaderCell>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {regions.map((region) => (
              <Table.Row key={region.id}>
                <Table.Cell>
                  {region.name}{" "}
                  <span className="text-ui-fg-muted">{region.currency_code.toUpperCase()}</span>
                </Table.Cell>
                {methods.map((method) => (
                  <Table.Cell key={method.provider_id}>
                    <Switch
                      checked={region.methods.includes(method.provider_id)}
                      disabled={busy !== null}
                      onCheckedChange={(checked) => void toggleRegion(region, method, checked)}
                    />
                  </Table.Cell>
                ))}
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
        <div className="grid gap-4 px-6 py-4 md:grid-cols-2">
          {methods.map((method) => {
            const off = !method.regions_on.length
            const remembered = paused[method.method]?.length ?? 0
            return (
              <div key={method.provider_id} className="flex flex-col gap-y-2">
                <Text size="small" weight="plus">
                  {METHOD_LABEL[method.method]}
                </Text>
                <Text size="small" className="text-ui-fg-subtle">
                  On in {method.regions_on.length} of {regions.length} regions ·{" "}
                  {method.waiting} waiting for payment
                  {method.method === "checkout" && method.waiting_without_link
                    ? `, ${method.waiting_without_link} without a payment link yet`
                    : ""}
                </Text>
                <div>
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy !== null || (off && !remembered)}
                    onClick={() => void toggleEverywhere(method, off)}
                  >
                    {off
                      ? remembered
                        ? `Turn back on in ${remembered} ${remembered === 1 ? "region" : "regions"}`
                        : "Off everywhere"
                      : "Turn off everywhere"}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </Section>

      <Section title="Afriex Checkout: what shoppers see on the payment page">
        <div className="flex flex-col gap-y-3 px-6 py-4">
          {CHANNELS.map((channel) => (
            <label key={channel.value} className="flex items-center gap-x-3">
              <Checkbox
                checked={channels ? channels.includes(channel.value) : true}
                disabled={busy !== null}
                onCheckedChange={(checked) => void saveChannels(channel.value, checked === true)}
              />
              <Text size="small">
                {channel.label}
                {channel.note ? (
                  <span className="text-ui-fg-muted"> — {channel.note}</span>
                ) : null}
              </Text>
            </label>
          ))}
          <Text size="small" className="text-ui-fg-muted">
            Afriex offers only what the currency can collect, so an option you allow may still not
            appear. In NGN that is the bank transfer.
          </Text>
        </div>
        <div className="flex items-start justify-between gap-x-4 px-6 py-4">
          <div>
            <Text size="small" weight="plus">
              Hide Afriex's bank transfer where you offer your own
            </Text>
            <Text size="small" className="text-ui-fg-subtle">
              Only where the currency is known to be payable another way, so a shopper is never left
              with nothing.
            </Text>
          </div>
          <Switch
            checked={settings.hideBankChannelWhereBankTransfer}
            disabled={busy !== null}
            onCheckedChange={(checked) =>
              void run(
                "hide-bank",
                () =>
                  post("/admin/afriex/settings", {
                    hide_bank_channel_where_bank_transfer: checked,
                  }),
                "Saved"
              )
            }
          />
        </div>
      </Section>

      <Section title="Payments needing attention">
        {!attention.length ? (
          <div className="px-6 py-4">
            <Text size="small" className="text-ui-fg-subtle">
              Nothing is waiting for you.
            </Text>
          </div>
        ) : (
          attention.map((item) =>
            item.kind === "session" ? (
              <div
                key={item.payment_session_id}
                className="flex items-center justify-between gap-x-4 px-6 py-4"
              >
                <div>
                  <Text size="small" weight="plus">
                    {item.display_id ? `Order #${item.display_id}` : "An order"} ·{" "}
                    {HELD_LABEL[item.status] ?? item.status}
                  </Text>
                  <Text size="small" className="text-ui-fg-subtle">
                    Expected {money(item.expected, item.currency)}, received{" "}
                    {money(item.received, item.currency)}
                    {item.extra_deposits
                      ? ` · ${item.extra_deposits} extra deposit${item.extra_deposits === 1 ? "" : "s"} to refund`
                      : ""}
                  </Text>
                </div>
                {item.order_id ? (
                  <Button size="small" variant="secondary" asChild>
                    <a href={`/app/orders/${item.order_id}`}>Open the order</a>
                  </Button>
                ) : null}
              </div>
            ) : (
              <div
                key={`${item.reference}:${item.transaction_id}`}
                className="flex items-center justify-between gap-x-4 px-6 py-4"
              >
                <div>
                  <Text size="small" weight="plus">
                    {item.display_id ? `Order #${item.display_id}` : "An order"} · late payment held
                  </Text>
                  <Text size="small" className="text-ui-fg-subtle">
                    {money(item.amount, item.currency)} arrived for {item.reference}, after its
                    payment was replaced.
                  </Text>
                </div>
                <div className="flex items-center gap-x-2">
                  {item.order_id ? (
                    <Button size="small" variant="transparent" asChild>
                      <a href={`/app/orders/${item.order_id}`}>Open the order</a>
                    </Button>
                  ) : null}
                  <Button
                    size="small"
                    variant="secondary"
                    disabled={busy !== null}
                    onClick={() => void applyLate(item)}
                  >
                    Apply to the order
                  </Button>
                </div>
              </div>
            )
          )
        )}
      </Section>
    </div>
  )
}

export const config = defineRouteConfig({ label: "Afriex" })

export default AfriexSettingsPage
