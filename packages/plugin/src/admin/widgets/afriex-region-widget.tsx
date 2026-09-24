import { defineWidgetConfig } from "@medusajs/admin-sdk"
import type { AdminRegion, DetailWidgetProps } from "@medusajs/framework/types"
import { Badge, Container, Heading, Switch, Text, toast, usePrompt } from "@medusajs/ui"
import { useCallback, useEffect, useState } from "react"
import { call } from "../lib/api"

type Method = {
  provider_id: string
  method: "bank_transfer" | "checkout"
  enabled: boolean
  waiting: number
}

const COPY: Record<Method["method"], { title: string; description: string }> = {
  bank_transfer: {
    title: "Bank transfer",
    description:
      "The shopper is shown an account created for their order and pays from their banking app.",
  },
  checkout: {
    title: "Afriex Checkout",
    description:
      "The shopper pays on a secure Afriex page, by mobile money or bank transfer, then comes back to your store.",
  },
}

/**
 * Turns each Afriex payment method on or off for this region. It edits the
 * same setting as the region's Payment Providers field, and explains what
 * each one is, which that field's short labels do not.
 */
const AfriexRegionWidget = ({ data: region }: DetailWidgetProps<AdminRegion>) => {
  const [methods, setMethods] = useState<Method[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const prompt = usePrompt()

  const load = useCallback(async () => {
    const { status, body } = await call(`/admin/afriex/regions/${region.id}/methods`)
    if (status === 200) {
      setMethods(body.methods)
      setLoadError(null)
    } else {
      setLoadError(body.message ?? "Afriex payment methods could not be loaded.")
    }
  }, [region.id])

  useEffect(() => {
    void load()
  }, [load])

  const toggle = async (method: Method, enabled: boolean) => {
    const { title } = COPY[method.method]

    if (!enabled) {
      const confirmed = await prompt({
        title: `Turn off ${title} in ${region.name}?`,
        description: [
          `Shoppers in ${region.name} won't be offered ${title}.`,
          method.waiting
            ? `${method.waiting} ${method.waiting === 1 ? "payment" : "payments"} started with it ${method.waiting === 1 ? "is" : "are"} still waiting for money; ${method.waiting === 1 ? "it" : "they"} will still be marked paid when the money arrives.`
            : "",
          method.method === "checkout"
            ? "Shoppers who chose it but have not opened their payment link yet will be asked to choose another option."
            : "",
        ]
          .filter(Boolean)
          .join(" "),
        confirmText: "Turn off",
        cancelText: "Cancel",
      })
      if (!confirmed) {
        return
      }
    }

    setBusy(method.provider_id)
    try {
      const send = (confirmEmpty: boolean) =>
        call(`/admin/afriex/regions/${region.id}/methods`, {
          method: "POST",
          body: JSON.stringify({
            provider_id: method.provider_id,
            enabled,
            confirm_empty: confirmEmpty,
          }),
        })

      let result = await send(false)

      if (result.status === 409 && result.body.code === "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS") {
        const confirmed = await prompt({
          title: `${region.name} will have no payment method`,
          description:
            "Shoppers in this region won't be able to pay for an order until you turn a payment method back on.",
          confirmText: "Turn off anyway",
          cancelText: "Keep it on",
        })
        if (!confirmed) {
          return
        }
        result = await send(true)
      }

      if (result.status === 200) {
        setMethods(result.body.methods)
        toast.success(`${title} turned ${enabled ? "on" : "off"} in ${region.name}`)
      } else {
        toast.error(result.body.message ?? `${title} could not be changed.`)
      }
    } finally {
      setBusy(null)
    }
  }

  return (
    <Container className="divide-y p-0">
      <div className="px-6 py-4">
        <Heading level="h2">Afriex payment methods</Heading>
        <Text size="small" className="text-ui-fg-subtle mt-1">
          Choose how shoppers in {region.name} can pay with Afriex.
        </Text>
      </div>

      {loadError ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-error">
            {loadError}
          </Text>
        </div>
      ) : null}

      {methods && !methods.length ? (
        <div className="px-6 py-4">
          <Text size="small" className="text-ui-fg-subtle">
            No Afriex payment provider is registered. Add it to medusa-config.ts.
          </Text>
        </div>
      ) : null}

      {methods?.map((method) => {
        const { title, description } = COPY[method.method]
        const inputId = `afriex-${method.provider_id}`

        return (
          <div key={method.provider_id} className="flex items-start justify-between gap-x-4 px-6 py-4">
            <div className="flex flex-col gap-y-1">
              <div className="flex items-center gap-x-2">
                <label htmlFor={inputId}>
                  <Text size="small" weight="plus">
                    {title}
                  </Text>
                </label>
                {method.waiting ? (
                  <Badge size="2xsmall" color="orange">
                    {method.waiting} waiting for payment
                  </Badge>
                ) : null}
              </div>
              <Text size="small" className="text-ui-fg-subtle">
                {description}
              </Text>
            </div>
            <Switch
              id={inputId}
              checked={method.enabled}
              disabled={busy !== null}
              onCheckedChange={(checked) => void toggle(method, checked)}
            />
          </div>
        )
      })}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "region.details.after",
})

export default AfriexRegionWidget
