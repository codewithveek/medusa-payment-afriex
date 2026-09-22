---
"medusa-payment-afriex": minor
---

Add Afriex Checkout: the shopper pays on a secure Afriex page, by mobile money or bank transfer, and comes back to your store. It is a second payment provider, `pp_afriex-checkout_afriex`, registered by the same provider entry as bank transfer (`pp_afriex_afriex`).

- **Two calls, the order placed in between.** Choosing Afriex Checkout sends nothing to Afriex. Once the order is placed, the same payment-session call on the order's payment collection creates the payment link. A cart edit can never leave a payable link for the wrong amount.
- **Configure it** with the new optional `checkout` block: `returnUrl` (HTTPS, `{order_id}` is replaced with the order's id), `allowedReturnOrigins`, `channels`, `currencyChannels` and `minorUnitExponents`. Without `returnUrl`, Afriex Checkout refuses to start and bank transfer is unaffected.
- **A middleware in front of every new payment session**, on the store and admin routes. It stops a payment in progress being replaced (`409 AFRIEX_PAYMENT_IN_PROGRESS`, with the open link), refuses cancelled or paid orders, and re-checks that the method is still on in the order's region. For Afriex Checkout it builds the customer from the cart or order and ignores what the storefront sent, except a `return_url` on an allowed origin.
- **Stable error codes** for storefronts: see Step 7b of the README.
- **Turn each method on or off per region** from a new card on the region page, or the new `GET`/`POST /admin/afriex/regions/:id/methods` routes. It tells you how many payments in the region are still waiting for money. Those still complete.
- The order widget shows the payment link, the options offered, how the shopper paid, failed attempts, and a warning when a bank transfer on Afriex's page failed.
- Amounts are sent to Afriex in minor units. Currencies without two decimal places are refused until `minorUnitExponents` names them.

Before relying on it, take one small real payment through each option you offer.
