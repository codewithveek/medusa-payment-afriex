import { createCookie } from "react-router"

/**
 * A real storefront would keep more in here (region, customer). One cart id is
 * all this example needs.
 */
const cartCookie = createCookie("afriex_example_cart", {
  path: "/",
  sameSite: "lax",
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 7,
})

export async function readCartId(request: Request): Promise<string | null> {
  return (await cartCookie.parse(request.headers.get("Cookie"))) ?? null
}

export async function writeCartId(cartId: string | null): Promise<string> {
  return cartCookie.serialize(cartId)
}
