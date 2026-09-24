---
"medusa-payment-afriex": minor
---

Add **Settings → Afriex** in the Medusa admin, and buttons for money the plugin held back.

- **One page for the whole store.** Which methods are on in which regions, as a grid of switches; what is still waiting for money, and how much of it has no payment link yet; which checkout options shoppers are offered; and what needs a person, with a link to each order.
- **Setup checks that only claim what the plugin can see**: a method registered but on in no region, whether Afriex Checkout has a return URL, and whether any webhook has ever arrived. Running more than one server instance is stated as a note, not a tick, because nothing in the plugin can tell how many are running.
- **Turn a method off everywhere**, and back on into exactly the regions it was on before — a region you deliberately never offered it in stays that way. It asks first if that leaves a region with no payment method at all.
- **Settle held money from the order page.** Where an order holds a payment, the widget offers "Accept as payment" and "Mark for refund"; money that arrived after a cancellation can only be refunded. A payment held against a replaced account or link gets "Apply to this order". Each asks for confirmation and says what it will do. Until now this needed `curl`.
- New admin routes behind all of it: `GET /admin/afriex/overview`, `POST /admin/afriex/methods/:method/everywhere`, `GET /admin/afriex/orders/:id/payment`.
