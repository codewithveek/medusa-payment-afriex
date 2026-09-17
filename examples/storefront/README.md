# Afriex payment example — storefront

A small [React Router](https://reactrouter.com) storefront that walks one cart
through the Afriex bank-transfer checkout, so you can see what the shopper sees.

It is deliberately not a full shop. There is one product, one shipping option
and no account system — everything that is here exists to reach the payment step
and show what the provider returns.

## The flow

| Route | What it does |
| --- | --- |
| `/` | The seeded product. Submitting creates a cart and stores its id in an `httpOnly` cookie. |
| `/checkout` | Address form. On submit: sets the address, picks the only shipping option, asks Medusa to open an Afriex payment session, and completes the cart. |
| `/order/:orderId` | The bank details to transfer to, and a poll that waits for the webhook. |

The interesting part is that the order exists **before** any money moves. The
provider returns `pending_authorization` at checkout, so Medusa places the order
in an awaiting-payment state rather than blocking on a transfer that may take
minutes. `/order/:orderId` therefore shows a real order that is not yet paid,
and revalidates every five seconds until the Afriex webhook flips it. There is
no "I have paid" button, because nothing the shopper clicks can move payment
state — only the webhook can.

## Running it

The backend has to be seeded and running first — see
[`../medusa-backend/README.md`](../medusa-backend/README.md).

```bash
cp .env.template .env   # paste the publishable key that `pnpm seed` printed
pnpm dev                # http://localhost:8000
```

Use the key from `pnpm seed`, not the "Default Sales Channel" key Medusa creates
on first boot — only the seeded one is linked to the sales channel the example
product is published in, and with the wrong key the product list comes back
empty.

## Notes for anyone lifting code out of this

- **Every Medusa call runs in a loader or an action.** The publishable key and
  the cart id never reach the browser. `app/lib/medusa.server.ts` is the only
  place the client is constructed.
- **Ask for `fields: "*items"` when you read a cart.** Line-item totals are
  computed, and without that they come back undefined and every line renders as
  zero.
- **The session shape is redeclared in `app/routes/order.tsx`.** The plugin
  publishes JavaScript without type declarations, so `AfriexPaymentInstructions`
  cannot be imported from it. If that changes, import it instead of the local
  copy.
- **Polling is the honest option here, not a shortcut.** A production storefront
  would likely push from the server instead, but it would still be reacting to
  the same webhook.
