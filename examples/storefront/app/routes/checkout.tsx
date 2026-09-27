import { useState } from "react"
import { Form, redirect, useNavigation } from "react-router"
import type { Route } from "./+types/checkout"
import {
  medusa,
  offeredMethods,
  storeApi,
  type AfriexMethod,
  type OfferedMethod,
} from "~/lib/medusa.server"
import { readCartId, writeCartId } from "~/lib/cart.server"
import { requestSession, startPayment } from "~/lib/pay.server"
import { describeChannels, sentenceCase } from "~/lib/channels"
import { formatAmount } from "~/lib/format"

export function meta() {
  return [{ title: "Checkout — Afriex Example Store" }]
}

const METHOD_COPY: Record<AfriexMethod, { title: string; button: string }> = {
  bank_transfer: { title: "Bank transfer", button: "Place order and get account details" },
  checkout: { title: "Pay with Afriex", button: "Place order and pay with Afriex" },
}

/** What each option means here — Afriex's page offers different things in different currencies. */
function detailOf({ method, channels }: OfferedMethod): string {
  if (method === "bank_transfer") {
    return "Get an account number made for this order, and pay from your banking app."
  }
  const by = describeChannels(channels)
  return `${by ? sentenceCase(by) : "Pay"} on a secure Afriex page. You come straight back here.`
}

/** A plausible address per country, so the demo form is ready to submit. */
const PREFILL: Record<string, { city: string; postalCode: string; phone: string }> = {
  ng: { city: "Lagos", postalCode: "101001", phone: "+2348012345678" },
  ke: { city: "Nairobi", postalCode: "00100", phone: "+254712345678" },
  gh: { city: "Accra", postalCode: "GA-100", phone: "+233241234567" },
  za: { city: "Cape Town", postalCode: "8001", phone: "+27821234567" },
  us: { city: "New York", postalCode: "10001", phone: "+12125550123" },
}

export async function loader({ request }: Route.LoaderArgs) {
  const cartId = await readCartId(request)
  if (!cartId) {
    throw redirect("/")
  }

  // Line-item totals are computed fields — without asking for `*items`
  // they come back undefined and every line renders as zero. `+` adds a field
  // to the defaults; without it, Medusa returns only the fields named.
  const { cart } = await medusa.store.cart.retrieve(cartId, {
    fields: "*items,+region_id,+shipping_total",
  })

  // Delivery is added when the order is placed, so show its price now: the
  // shopper must see the amount they will actually be asked to pay.
  // A cart that already has delivery on it (a submission that failed partway)
  // counts it in its own total; otherwise it is added here.
  const { shipping_options } = await medusa.store.fulfillment.listCartOptions({ cart_id: cartId })
  const deliveryOnCart = cart.shipping_total ?? 0
  const delivery = deliveryOnCart > 0 ? deliveryOnCart : shipping_options[0]?.amount ?? 0
  const totalToPay = deliveryOnCart > 0 ? cart.total ?? 0 : (cart.total ?? 0) + delivery

  // The demo prefills an address in the region's country, so the form can be
  // submitted as it is; a real storefront asks the shopper.
  const country = cart.region_id
    ? (await medusa.store.region.retrieve(cart.region_id)).region.countries?.[0]?.iso_2
    : undefined
  const prefill = PREFILL[country ?? ""] ?? { city: "", postalCode: "", phone: "" }

  return {
    methods: cart.region_id ? await offeredMethods(cart.region_id) : [],
    prefill: { country: country ?? "", ...prefill },
    delivery,
    totalToPay,
    cart: {
      currencyCode: cart.currency_code,
      items: (cart.items ?? []).map((item) => ({
        id: item.id,
        title: `${item.product_title} · ${item.variant_title}`,
        quantity: item.quantity,
        total: item.total ?? 0,
      })),
      total: cart.total ?? 0,
    },
  }
}

export async function action({ request }: Route.ActionArgs) {
  const cartId = await readCartId(request)
  if (!cartId) {
    throw redirect("/")
  }

  const form = await request.formData()
  const method = (String(form.get("method")) === "checkout" ? "checkout" : "bank_transfer") as AfriexMethod
  const address = {
    first_name: String(form.get("firstName")),
    last_name: String(form.get("lastName")),
    address_1: String(form.get("address1")),
    city: String(form.get("city")),
    postal_code: String(form.get("postalCode")),
    country_code: String(form.get("countryCode")),
    phone: String(form.get("phone")),
  }

  try {
    await medusa.store.cart.update(cartId, {
      email: String(form.get("email")),
      shipping_address: address,
      billing_address: address,
    })

    // One seeded option, so no picker — a real storefront would let the
    // shopper choose.
    const { shipping_options } = await medusa.store.fulfillment.listCartOptions({
      cart_id: cartId,
    })
    const option = shipping_options[0]
    if (!option) {
      throw new Error(
        "No shipping option for this address. Re-run `pnpm seed` in examples/medusa-backend."
      )
    }
    await medusa.store.cart.addShippingMethod(cartId, { option_id: option.id })

    const collection = await storeApi<{ payment_collection: { id: string } }>(
      "/store/payment-collections",
      { method: "POST", body: { cart_id: cartId } }
    )
    if (!collection.ok) {
      throw new Error(collection.body.message ?? "The cart could not be prepared for payment.")
    }

    // Choosing the method. For bank transfer this mints the account now; for
    // Afriex Checkout nothing is sent to Afriex yet — the plugin only checks the
    // cart could be paid that way (an email, a phone number, the currency).
    const chosen = await requestSession(collection.data.payment_collection.id, method)
    if (chosen.kind === "needs_detail") {
      return { error: chosen.message, field: chosen.field, method }
    }
    if (chosen.kind !== "placed" && chosen.kind !== "redirect") {
      return { error: chosen.message, method }
    }

    // The shopper has not paid, and that is the point: the order is placed as
    // awaiting payment instead of checkout waiting on the money.
    const completed = await medusa.store.cart.complete(cartId)
    if (completed.type !== "order") {
      throw new Error(completed.error?.message ?? "Could not place the order.")
    }
    const orderId = completed.order.id
    const clearCart = { "Set-Cookie": await writeCartId(null) }

    if (method === "bank_transfer") {
      return redirect(`/order/${orderId}`, { headers: clearCart })
    }

    // Now the order exists, the payment link can be made — for this order, at
    // this total. If that fails the order is still placed; its page offers
    // to try again.
    const paying = await startPayment(orderId, "checkout")
    if (paying.kind === "redirect") {
      return redirect(paying.url, { headers: clearCart })
    }
    const problem = "message" in paying ? `?problem=${encodeURIComponent(paying.message)}` : ""
    return redirect(`/order/${orderId}${problem}`, { headers: clearCart })
  } catch (error) {
    return {
      method,
      error: error instanceof Error ? error.message : "Checkout failed for an unknown reason.",
    }
  }
}

export default function Checkout({ loaderData, actionData }: Route.ComponentProps) {
  const { cart, methods, prefill, delivery, totalToPay } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== "idle"
  const [selected, setSelected] = useState<AfriexMethod | undefined>(
    actionData?.method ?? methods[0]?.method
  )

  return (
    <>
      <section className="card">
        <h2>Order summary</h2>
        {cart.items.map((item) => (
          <div className="line" key={item.id}>
            <span>
              {item.title} × {item.quantity}
            </span>
            <span>{formatAmount(item.total, cart.currencyCode)}</span>
          </div>
        ))}
        <div className="line">
          <span>Delivery</span>
          <span>{formatAmount(delivery, cart.currencyCode)}</span>
        </div>
        <div className="line total">
          <span>Total to pay</span>
          <span>{formatAmount(totalToPay, cart.currencyCode)}</span>
        </div>
      </section>

      <section className="card">
        <h1>Delivery details</h1>
        <p className="muted">Prefilled so you can get to the payment step quickly.</p>

        <Form method="post">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              defaultValue="shopper@example.com"
              required
              aria-invalid={actionData?.field === "email" || undefined}
            />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="firstName">First name</label>
              <input id="firstName" name="firstName" defaultValue="Ada" required />
            </div>
            <div className="field">
              <label htmlFor="lastName">Last name</label>
              <input id="lastName" name="lastName" defaultValue="Obi" required />
            </div>
          </div>
          <div className="field">
            <label htmlFor="address1">Address</label>
            <input id="address1" name="address1" defaultValue="12 Marina Road" required />
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="city">City</label>
              <input id="city" name="city" defaultValue={prefill.city} required />
            </div>
            <div className="field">
              <label htmlFor="postalCode">Postal code</label>
              <input id="postalCode" name="postalCode" defaultValue={prefill.postalCode} required />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="countryCode">Country</label>
              <input id="countryCode" name="countryCode" defaultValue={prefill.country} required />
            </div>
            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input
                id="phone"
                name="phone"
                defaultValue={prefill.phone}
                required
                aria-invalid={actionData?.field === "phone" || undefined}
              />
            </div>
          </div>

          <h2 className="section-title">How would you like to pay?</h2>
          {methods.length ? (
            <div className="methods" role="radiogroup" aria-label="Payment method">
              {methods.map((offer) => (
                <label className="method" key={offer.method}>
                  <input
                    type="radio"
                    name="method"
                    value={offer.method}
                    checked={offer.method === selected}
                    onChange={() => setSelected(offer.method)}
                  />
                  <span>
                    <strong>{METHOD_COPY[offer.method].title}</strong>
                    <span className="muted">{detailOf(offer)}</span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="error">
              No Afriex payment method is available in this region. Turn one on in the admin, on
              the region's page — it says there if Afriex cannot collect this currency yet.
            </p>
          )}

          {actionData?.error ? <p className="error">{actionData.error}</p> : null}

          {methods.length ? (
            <button className="wide" disabled={busy}>
              {busy
                ? selected === "checkout"
                  ? "Placing your order…"
                  : "Getting your account details…"
                : METHOD_COPY[selected ?? "bank_transfer"].button}
            </button>
          ) : null}
        </Form>
      </section>
    </>
  )
}
