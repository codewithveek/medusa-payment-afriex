---
"medusa-payment-afriex": minor
---

Keep a record of every account the plugin hands out, and settle held money from the admin API. **Run `npx medusa db:migrate` after upgrading**: this adds the `afriex_payment_reference` and `afriex_settlement` tables.

- A transfer into an account whose payment session Medusa has since deleted (the cart changed, or the shopper switched method) is now traced to its order and held, instead of being logged as matching nothing.
- A database constraint allows one Afriex capture per order, even on servers that do not share a lock. A second deposit is recorded as money to refund.
- New admin API routes: `POST /admin/afriex/sessions/:id/resolve` accepts or refunds a deposit the plugin held back (a wrong amount, a changed order total, a cancelled order), and `POST /admin/afriex/references/:reference/apply` applies a held late payment to its order. Medusa's own "Mark as paid" cannot settle these orders.
