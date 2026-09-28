# medusa-payment-afriex

## 0.2.0

### Minor Changes

- bdf3768: Add **Settings → Afriex** in the Medusa admin, and buttons for money the plugin held back.

  - **One page for the whole store.** Which methods are on in which regions, as a grid of switches; what is still waiting for money, and how much of it has no payment link yet; which checkout options shoppers are offered; and what needs a person, with a link to each order.
  - **Setup checks that only claim what the plugin can see**: a method registered but on in no region, whether Afriex Checkout has a return URL, and whether any webhook has ever arrived. Running more than one server instance is stated as a note, not a tick, because nothing in the plugin can tell how many are running.
  - **Turn a method off everywhere**, and back on into exactly the regions it was on before — a region you deliberately never offered it in stays that way. It asks first if that leaves a region with no payment method at all.
  - **Settle held money from the order page.** Where an order holds a payment, the widget offers "Accept as payment" and "Mark for refund"; money that arrived after a cancellation can only be refunded. A payment held against a replaced account or link gets "Apply to this order". Each asks for confirmation and says what it will do. Until now this needed `curl`.
  - New admin routes behind all of it: `GET /admin/afriex/overview`, `POST /admin/afriex/methods/:method/everywhere`, `GET /admin/afriex/orders/:id/payment`.

- 1f36b0c: Add Afriex Checkout: the shopper pays on a secure Afriex page, by mobile money or bank transfer, and comes back to your store. It is a second payment provider, `pp_afriex-checkout_afriex`, registered by the same provider entry as bank transfer (`pp_afriex_afriex`).

  - **Two calls, the order placed in between.** Choosing Afriex Checkout sends nothing to Afriex. Once the order is placed, the same payment-session call on the order's payment collection creates the payment link. A cart edit can never leave a payable link for the wrong amount.
  - **Configure it** with the new optional `checkout` block: `returnUrl` (HTTPS, `{order_id}` is replaced with the order's id), `allowedReturnOrigins`, `channels`, `currencyChannels` and `minorUnitExponents`. Without `returnUrl`, Afriex Checkout refuses to start and bank transfer is unaffected.
  - **A middleware in front of every new payment session**, on the store and admin routes. It stops a payment in progress being replaced (`409 AFRIEX_PAYMENT_IN_PROGRESS`, with the open link), refuses cancelled or paid orders, and re-checks that the method is still on in the order's region. For Afriex Checkout it builds the customer from the cart or order and ignores what the storefront sent, except a `return_url` on an allowed origin.
  - **Stable error codes** for storefronts: see Step 7b of the README. A refusal that repeating will not fix — Afriex answering `403` or `404` for your store — hides the method and names the cause in your log, instead of telling the shopper to try again.
  - **Turn each method on or off per region** from a new card on the region page, or the new `GET`/`POST /admin/afriex/regions/:id/methods` routes. It tells you how many payments in the region are still waiting for money. Those still complete.
  - The order widget shows the payment link, the options offered, how the shopper paid, failed attempts, and a warning when a bank transfer on Afriex's page failed.
  - Amounts are sent to Afriex in minor units. Currencies without two decimal places are refused until `minorUnitExponents` names them.

  Before relying on it, take one small real payment through each option you offer.

- 35a856a: Finish the parts of Afriex Checkout that were running on assumptions. **Run `npx medusa db:migrate` after upgrading**: the reference ledger gains two columns and there is a new `afriex_setting` table.

  - **A payment link's expiry is now Afriex's own.** `CHECKOUT_SESSION.CREATED` is handled, and its `expiresAt` and session id are written onto the payment session and the ledger. Before, the plugin assumed 15 minutes, which the storefront, the admin widget and the replacement guard all read. The event never captures and never compares amounts, whatever it carries.
  - **Money that arrives for a replaced account or link is applied on its own**, when the order has exactly one unpaid Afriex payment for exactly that amount, and nothing else has claimed it. Anything less certain is still held, and the log now says which condition stopped it.
  - **New `GET`/`POST /admin/afriex/settings`**: choose which options shoppers are offered on Afriex's page, store-wide, without editing `medusa-config.ts`.
  - **Optionally hide Afriex's bank transfer** where you already offer the plugin's own — but only where the currency is known to be payable another way, so a shopper is never left with nothing. If Afriex refuses anyway, the plugin asks again with it restored and logs that it did.
  - The webhook simulator can send `--event CHECKOUT_SESSION.CREATED`.

- c66ac76: Offer each Afriex method only where Afriex can collect the currency, in every country Afriex serves — not just Nigeria.

  - **Afriex's coverage, built in.** The plugin carries Afriex's published deposit coverage per currency: which take a virtual account, which take mobile money, which are still coming. A method that cannot collect a region's currency is refused on the cart, before any order exists, with a code (`AFRIEX_BANK_TRANSFER_UNAVAILABLE_FOR_CURRENCY`, `AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY`). Your options win over the table: `bankTransfer.currencies` and `checkout.currencyChannels`.
  - **`GET /store/afriex/methods?region_id=…`** tells a storefront which Afriex methods to show in a region, and what Afriex's page will offer there, so it can say "mobile money" in Kenya and "bank transfer" in Nigeria.
  - **The admin says why.** The Settings page warns where a method is on but Afriex cannot collect; each region's page shows the reason, and what the payment page offers in that currency.
  - **Afriex's compliance review** for a new currency now answers `AFRIEX_BANK_TRANSFER_AWAITING_APPROVAL`, with the currency named in the log and a note on the Settings page.
  - **The country comes from the order** — the address, else the currency's own country — and is never assumed to be Nigeria. `defaultCountryCode` is only a last resort.
  - **Smallest units follow ISO 4217**: a franc or a shilling with no smaller coin is sent as a whole unit, without configuration. `minorUnitExponents` still overrides.
  - The example storefront asks the new route, words each option for the currency, and prefills an address in the region's country.

- 1f36b0c: Keep a record of every account the plugin hands out, and settle held money from the admin API. **Run `npx medusa db:migrate` after upgrading**: this adds the `afriex_payment_reference` and `afriex_settlement` tables.

  - A transfer into an account whose payment session Medusa has since deleted (the cart changed, or the shopper switched method) is now traced to its order and held, instead of being logged as matching nothing.
  - A database constraint allows one Afriex capture per order, even on servers that do not share a lock. A second deposit is recorded as money to refund.
  - New admin API routes: `POST /admin/afriex/sessions/:id/resolve` accepts or refunds a deposit the plugin held back (a wrong amount, a changed order total, a cancelled order), and `POST /admin/afriex/references/:reference/apply` applies a held late payment to its order. Medusa's own "Mark as paid" cannot settle these orders.

- 1f36b0c: Remove the experimental `pool` collection method and the `collectionMethod` option. An Afriex pool deposit is confirmed only after a proof of payment is uploaded by hand, so the plugin could never mark such an order paid on its own. Bank transfer now always uses a virtual account created for the order. A `collectionMethod` value left in `medusa-config.ts` is ignored.
- 0dff20d: Test Afriex Checkout end to end against Afriex's sandbox, with the outcome you choose.

  - **`data.sandbox` on the pay call** — `{ outcome: "success" | "fail", instant: true, otp: true | false }` — makes the plugin add Afriex's sandbox control words to the `merchantReference` it sends (`payses_…--SIMULATE_INSTANT_FAIL`), so Afriex settles the payment as asked, in about 30 seconds with `instant`. Webhooks are matched on the session id as before: the words are stripped on the way back. Production ignores the request and says so in the log.
  - **`pnpm checkout:e2e --sandbox fail --instant`** places an order, asks for the link with that outcome, and watches the order until Afriex's webhook has moved it — `--otp yes --afriex-api-key …` also enters the sandbox one-time password.

### Patch Changes

- 1f36b0c: Split the payment provider into a shared base and a bank-transfer service, ready for a second Afriex payment method. The provider id stays `pp_afriex_afriex`; the old `AfriexPaymentProviderService` export and the `providers/afriex-payment/service` import path keep working.

  - The bank-transfer provider now sets every session field it later trusts when it creates the session. Before, values a storefront sent in the session `data` (a status, a received amount, a refund line) survived Medusa's merge.
  - A storefront can no longer choose which Afriex customer a new virtual account is minted for. Before, an `afriexCustomerId` in the session `data` sent at checkout was used as is.

- 1f36b0c: Harden webhook reconciliation. **Run `npx medusa db:migrate` after upgrading**: the processed-webhook table gains a `completed_at` column.

  - A webhook is now checked against every Afriex provider registration, and accepted when the session's own provider is one of those that verified it. Previously the first registration that verified won, so a second Afriex provider sharing the same webhook key had its payments refused with `401`.
  - Deposits for one payment session are now recorded one at a time, capture included, under a lock. Before, two different transfers settling at the same moment could both be captured, and one of them was never recorded as money to refund.
  - A redelivery that arrives while the first delivery of the same event is still being processed now gets a retryable `503` instead of `200 duplicate`. Before, if that first attempt then failed, Afriex had already stopped retrying and the deposit was never recorded. A claim left behind by a crashed process is taken over after five minutes.
  - A deposit that settles after its order was cancelled is no longer captured. It is recorded as `SETTLED_AFTER_CANCEL`, logged at error level, and shown in the admin widget as needing a refund. A capture that races an admin cancelling the order is flagged the same way. The check reads the order, not only the payment collection, because Medusa can recompute a cancelled collection back to `awaiting`.
  - A deposit that settles after an admin changed the order total (order edit, claim or exchange) is no longer captured at the old total. It is recorded as `COLLECTION_AMOUNT_CHANGED` for review.
  - A deposit on a session whose payment collection was already paid through another session is recorded as an extra deposit to refund, not captured a second time.
  - A deposit held because its amount or currency did not match is now logged at **error** level, like the other held cases. It was a warning, so a store forwarding only error-level logs — as the README says to — never heard about money it was holding.
