---
"medusa-payment-afriex": minor
---

Test Afriex Checkout end to end against Afriex's sandbox, with the outcome you choose.

- **`data.sandbox` on the pay call** — `{ outcome: "success" | "fail", instant: true, otp: true | false }` — makes the plugin add Afriex's sandbox control words to the `merchantReference` it sends (`payses_…--SIMULATE_INSTANT_FAIL`), so Afriex settles the payment as asked, in about 30 seconds with `instant`. Webhooks are matched on the session id as before: the words are stripped on the way back. Production ignores the request and says so in the log.
- **`pnpm checkout:e2e --sandbox fail --instant`** places an order, asks for the link with that outcome, and watches the order until Afriex's webhook has moved it — `--otp yes --afriex-api-key …` also enters the sandbox one-time password.
