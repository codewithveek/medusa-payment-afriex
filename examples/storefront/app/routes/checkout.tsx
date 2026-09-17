import { Form, redirect, useNavigation } from "react-router"
import type { Route } from "./+types/checkout"
import { AFRIEX_PROVIDER_ID, medusa } from "~/lib/medusa.server"
import { readCartId, writeCartId } from "~/lib/cart.server"
import { formatAmount } from "~/lib/format"

export function meta() {
  return [{ title: "Checkout — Afriex Example Store" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const cartId = await readCartId(request)
  if (!cartId) {
    throw redirect("/")
  }

  // Line-item totals are computed fields — without asking for `*items`
  // they come back undefined and every line renders as zero.
  const { cart } = await medusa.store.cart.retrieve(cartId, {
    fields: "*items",
  })
  return {
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

    // Asks the provider to mint the collection account. The session comes back
    // `pending` — nothing has been paid yet.
    const { cart } = await medusa.store.cart.retrieve(cartId)
    await medusa.store.payment.initiatePaymentSession(cart, {
      provider_id: AFRIEX_PROVIDER_ID,
    })

    // The shopper has not paid, and that is the point: the provider returns
    // `pending_authorization`, so Medusa places the order in an
    // awaiting-payment state instead of blocking checkout on the transfer.
    const completed = await medusa.store.cart.complete(cartId)
    if (completed.type !== "order") {
      throw new Error(completed.error?.message ?? "Could not place the order.")
    }

    return redirect(`/order/${completed.order.id}`, {
      headers: { "Set-Cookie": await writeCartId(null) },
    })
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "Checkout failed for an unknown reason.",
    }
  }
}

export default function Checkout({
  loaderData,
  actionData,
}: Route.ComponentProps) {
  const { cart } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== "idle"

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
        <div className="line total">
          <span>Total</span>
          <span>{formatAmount(cart.total, cart.currencyCode)}</span>
        </div>
      </section>

      <section className="card">
        <h1>Delivery details</h1>
        <p className="muted">
          Prefilled so you can get to the payment step quickly.
        </p>

        <Form method="post">
          <div className="field">
            <label htmlFor="email">Email</label>
            <input id="email" name="email" type="email" defaultValue="shopper@example.com" required />
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
              <input id="city" name="city" defaultValue="Lagos" required />
            </div>
            <div className="field">
              <label htmlFor="postalCode">Postal code</label>
              <input id="postalCode" name="postalCode" defaultValue="101001" required />
            </div>
          </div>
          <div className="row">
            <div className="field">
              <label htmlFor="countryCode">Country</label>
              <input id="countryCode" name="countryCode" defaultValue="ng" required />
            </div>
            <div className="field">
              <label htmlFor="phone">Phone</label>
              <input id="phone" name="phone" defaultValue="+2348012345678" required />
            </div>
          </div>

          <button className="wide" disabled={busy}>
            {busy ? "Getting your account details…" : "Pay by bank transfer"}
          </button>
        </Form>

        {actionData?.error ? (
          <>
            <p className="note" style={{ marginTop: 18 }}>
              Checkout could not reach Afriex. With placeholder credentials this
              is expected — the provider calls the Afriex API to mint the
              account and it rejected the key.
            </p>
            <pre className="error">{actionData.error}</pre>
          </>
        ) : null}
      </section>
    </>
  )
}
