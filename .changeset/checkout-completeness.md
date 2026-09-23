---
"medusa-payment-afriex": minor
---

Finish the parts of Afriex Checkout that were running on assumptions. **Run `npx medusa db:migrate` after upgrading**: the reference ledger gains two columns and there is a new `afriex_setting` table.

- **A payment link's expiry is now Afriex's own.** `CHECKOUT_SESSION.CREATED` is handled, and its `expiresAt` and session id are written onto the payment session and the ledger. Before, the plugin assumed 15 minutes, which the storefront, the admin widget and the replacement guard all read. The event never captures and never compares amounts, whatever it carries.
- **Money that arrives for a replaced account or link is applied on its own**, when the order has exactly one unpaid Afriex payment for exactly that amount, and nothing else has claimed it. Anything less certain is still held, and the log now says which condition stopped it.
- **New `GET`/`POST /admin/afriex/settings`**: choose which options shoppers are offered on Afriex's page, store-wide, without editing `medusa-config.ts`.
- **Optionally hide Afriex's bank transfer** where you already offer the plugin's own — but only where the currency is known to be payable another way, so a shopper is never left with nothing. If Afriex refuses anyway, the plugin asks again with it restored and logs that it did.
- The webhook simulator can send `--event CHECKOUT_SESSION.CREATED`.
