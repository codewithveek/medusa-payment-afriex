import { Form, redirect, useNavigation } from "react-router"
import type { Route } from "./+types/home"
import { medusa } from "~/lib/medusa.server"
import { writeCartId } from "~/lib/cart.server"
import { formatAmount } from "~/lib/format"

export function meta() {
  return [{ title: "Afriex Example Store" }]
}

export async function loader({ request }: Route.LoaderArgs) {
  const { regions } = await medusa.store.region.list()
  // `?region=reg_…` shops in another of the store's regions; the first is the default.
  const wanted = new URL(request.url).searchParams.get("region")
  const region = regions.find((candidate) => candidate.id === wanted) ?? regions[0]
  if (!region) {
    throw new Error("No region. Run `pnpm seed` in examples/medusa-backend.")
  }

  const { products } = await medusa.store.product.list({
    region_id: region.id,
    fields: "*variants.calculated_price",
    limit: 1,
  })
  const product = products[0]
  if (!product) {
    throw new Error("No product. Run `pnpm seed` in examples/medusa-backend.")
  }

  return {
    regionId: region.id,
    product: {
      title: product.title,
      description: product.description,
      variants: (product.variants ?? []).map((variant) => ({
        id: variant.id,
        title: variant.title,
        amount: variant.calculated_price?.calculated_amount ?? 0,
        currencyCode: variant.calculated_price?.currency_code ?? "ngn",
      })),
    },
  }
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData()
  const variantId = String(form.get("variantId"))
  const regionId = String(form.get("regionId"))

  // A fresh cart per attempt keeps the example predictable.
  const { cart } = await medusa.store.cart.create({ region_id: regionId })
  await medusa.store.cart.createLineItem(cart.id, {
    variant_id: variantId,
    quantity: 1,
  })

  return redirect("/checkout", {
    headers: { "Set-Cookie": await writeCartId(cart.id) },
  })
}

export default function Home({ loaderData }: Route.ComponentProps) {
  const { product, regionId } = loaderData
  const navigation = useNavigation()
  const busy = navigation.state !== "idle"
  const first = product.variants[0]

  return (
    <section className="card">
      <h1>{product.title}</h1>
      <p className="muted">{product.description}</p>

      <Form method="post">
        <input type="hidden" name="regionId" value={regionId} />
        <div className="field">
          <label htmlFor="variantId">Size</label>
          <select id="variantId" name="variantId" defaultValue={first?.id}>
            {product.variants.map((variant) => (
              <option key={variant.id} value={variant.id}>
                {variant.title} — {formatAmount(variant.amount, variant.currencyCode)}
              </option>
            ))}
          </select>
        </div>
        <button className="wide" disabled={busy}>
          {busy ? "Creating cart…" : "Buy now"}
        </button>
      </Form>
    </section>
  )
}
