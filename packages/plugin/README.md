# medusa-payment-afriex

<p dir="auto"><a target="_blank" rel="noopener noreferrer nofollow" href="./medusa-afriex-plugin.png"><img src="./medusa-afriex-plugin.png" alt="Medusa Afriex Plugin" style="max-width: 100%;"></a></p>

A Medusa v2 payment provider that lets a storefront collect payment through
Afriex's bank rails — a **dedicated virtual account** minted per order, or a
standing **pool account** the shopper quotes a reference against. Deposits are
confirmed by webhook, and the order is completed from that webhook alone.

Built on [`@afriex/sdk`](https://www.npmjs.com/package/@afriex/sdk), which is a
regular dependency and is never vendored — the installing project's version wins.

---

## How the payment actually flows

Afriex bank collection is asynchronous. Nothing at checkout can tell you whether
the shopper will complete the transfer, so the plugin does not pretend otherwise:

1. **Checkout** — the shopper picks Afriex. `initiatePayment` creates the
   account they will pay into and returns the details for the storefront to
   render. The session sits at `pending`.
2. **Place order** — the shopper can complete the cart before paying. The
   provider returns `pending_authorization`, so Medusa creates the order in an
   awaiting-payment state instead of blocking checkout on money that has not
   moved yet.
3. **Transfer lands** — Afriex sends `TRANSACTION.UPDATED`. The plugin verifies
   the signature, checks the amount, asks Medusa to authorize, capture, and
   complete the cart, and then confirms that a payment and an order actually
   exist before it tells Afriex the event was handled.

The webhook is the only thing that can mark an order paid. There is no "I have
paid" button, no polling from the storefront, and no path where a shopper's
claim moves payment state.

---

## Install

```bash
npm install medusa-payment-afriex
```

Requires Medusa `>= 2.21`, Node `>= 20.19`, and Postgres.

> **Node floor.** `@afriex/sdk` ships as ESM and this plugin compiles to
> CommonJS, so it relies on Node's `require(esm)` support — unflagged in Node
> 20.19 and 22.12. Older Node will fail at load time.

### 1. Register the plugin and the provider

```ts
// medusa-config.ts
module.exports = defineConfig({
  plugins: ["medusa-payment-afriex"],
  modules: [
    {
      resolve: "@medusajs/payment",
      options: {
        providers: [
          {
            resolve: "medusa-payment-afriex/providers/afriex-payment",
            id: "afriex",
            options: {
              apiKey: process.env.AFRIEX_API_KEY,
              environment: process.env.AFRIEX_ENVIRONMENT, // "staging" | "production" — required
              webhookPublicKey: process.env.AFRIEX_WEBHOOK_PUBLIC_KEY,
              collectionMethod:
                process.env.AFRIEX_COLLECTION_METHOD ?? "dedicated",
              defaultCountryCode: "NG",
            },
          },
        ],
      },
    },
  ],
});
```

Registering the plugin is what brings in the webhook route, the admin widget,
the pruning job, and the table behind webhook idempotency. Registering only the
provider gives you the payment methods without any of those.

The provider refuses to start unless all three of these are right:

- `apiKey` and `webhookPublicKey` are present. A provider that cannot verify a
  signature can never safely confirm an order.
- `webhookPublicKey` parses as a public key. The SDK would otherwise treat every
  signature as invalid, and the only symptom would be Afriex retrying against a
  401.
- `environment` is exactly `"staging"` or `"production"`. The SDK defaults to
  production when this is missing, so the plugin makes it an explicit decision.

### 2. Run the migration

```bash
npx medusa db:migrate
```

This creates `afriex_processed_webhook`, a single table in your own Medusa
database. The plugin deliberately does not ask you to run Redis or any separate
service just to deduplicate webhook deliveries. A scheduled job prunes rows
older than 90 days every night at 03:00.

### 3. Point Afriex at the webhook

Register **one** URL in the Afriex dashboard:

```
https://your-store.com/afriex/webhook
```

Medusa's generic `/hooks/payment/afriex_afriex` endpoint exists on every Medusa
server but **does not work for this provider**: capture is gated on a status
that only the plugin's own route writes, so events sent there are verified and
then go nowhere. Register `/afriex/webhook` only.

---

## Collection methods

|                            | `dedicated`                                                    | `pool`                                      |
| -------------------------- | -------------------------------------------------------------- | ------------------------------------------- |
| Account                    | One virtual account per order, scoped to the exact total       | One standing account for the country        |
| Shopper quotes a reference | No                                                             | **Yes — required**                          |
| Expires                    | Yes — the instructions carry the minutes when Afriex reports them | No                                       |
| Closed when the session ends | Yes, on cancel, delete, or a change of total                 | Never — shared infrastructure               |
| Best for                   | Lower volume, where a wrong reference is the main failure mode | High volume, or shoppers who pay repeatedly |
| Afriex customer            | One per shopper, reused across checkouts (see below)           | None                                        |

Both endpoints are production-only at Afriex, so neither can be exercised
end-to-end in the sandbox.

### Afriex customers

For dedicated accounts, the provider registers a logged-in shopper with Afriex
once, as a Medusa **account holder**, and every later checkout reuses that
customer. Within one session, a re-minted account (after the cart total
changes) also reuses the customer the first account was created for.

Afriex requires an email and a phone number. A shopper without both — most
guests — is not registered, and their virtual account is minted against the
business instead. Nothing is sent with empty contact fields.

### What the storefront receives

`payment_session.data.instructions` is plain data, not markup — render it to fit
your theme:

```jsonc
{
  "bankName": "Providus Bank",
  "accountNumber": "0123456789",
  "accountName": "Afriex / Order",
  "reference": "payses_01J...", // pool only
  "note": "Include the reference exactly as shown when making your transfer.",
  "expiresNote": "This account expires in 30 minutes — ...", // dedicated only
  "expiresInMinutes": 30 // dedicated only, when Afriex reports it
}
```

---

## How a deposit is matched to an order

The Medusa payment session id is set as the Afriex `reference` when the account
is created, and Afriex echoes it back on every transaction. That is the primary
thread from a deposit to its cart.

For dedicated accounts there is a second one: the transaction names the account
it landed in (`destinationId`), and the plugin remembers which session each
account was minted for. If the reference is missing or garbled, the plugin
looks the session up by account among that provider's sessions from the last
seven days. Pool accounts are shared, so no such fallback exists for them — the
reference is the only thing that attributes a pool deposit.

An event that matches nothing is acknowledged and otherwise ignored. It is never
applied to a best-guess order. If that event reports a **settled** deposit, it
is logged at error level, because that is money the store holds with no order
to attach it to.

## When the amount does not match

A settled deposit whose amount or currency differs from the session — under, over,
or in the wrong currency — is **not** captured. The session is moved to
`requires_more`, the discrepancy is written to the session data and the log, and
the order waits for a human. The admin widget on the order page shows what was
expected against what arrived, whether or not the order has a payment yet.

## When more money arrives than the order needed

Two settled transfers can land on one session: a shopper pays twice, or pays
the wrong amount and then the right one. Neither extra deposit is lost. It is
recorded on the session as an **extra deposit**, logged at error level, and
listed in the admin widget with the transaction id, so it can be refunded.

## Status mapping

| Afriex                                                                         | Medusa session  | Effect                                                |
| ------------------------------------------------------------------------------ | --------------- | ----------------------------------------------------- |
| `PENDING`, `PROCESSING`, `RETRY`, `SCHEDULED`                                  | `pending`       | Recorded; an in-flight session's status is left alone |
| `SUCCESS`                                                                      | `captured`      | Authorized, captured, cart completed                  |
| `FAILED`, `REJECTED`                                                           | `error`         | Recorded, order left unpaid                           |
| `CANCELLED`                                                                    | `canceled`      | Recorded                                              |
| `IN_REVIEW`, `CUSTOMER_ACTION_REQUIRED`, `REFUNDED`, `UNKNOWN`, any `DISPUTE*` | `requires_more` | Flagged for a human                                   |
| anything unrecognised                                                          | `pending`       | Never confirms, never fails                           |

Once a session has recorded `SUCCESS` or an amount mismatch, no later progress
event can move it back. Afriex delivers events in parallel and not always in
order, and a `PROCESSING` that arrives after `SUCCESS` must not make Medusa
defer a deposit that has already settled.

## What the webhook route guarantees

- **Nothing is read or written before the signature verifies.** The body is
  parsed only to see whether it is a transaction event at all; the signature is
  then checked against every registered Afriex provider before the reference
  is used for anything. An unverified request never reaches the database.
- **A reference is only ever a string.** Anything else in that field is
  acknowledged and ignored, not passed to a lookup.
- **Only a genuine miss is a miss.** If the session lookup fails for any other
  reason, the route returns 500 so Afriex retries, rather than acknowledging an
  event it could not act on.
- **"Handled" means handled.** After the capture workflow runs, the route checks
  that a payment now exists on the session and that the cart became an order.
  If either is missing, it returns 500, releases its idempotency claim, and logs
  at error level, so the retry gets another attempt and the failure is visible
  each time. (Medusa itself would otherwise swallow a failed cart completion.)
- **One capture per deposit.** Every delivery claims an id built from the
  payload before it is processed; a redelivery is a no-op.

---

## Limitations in v1

- **No refunds.** `refundPayment` throws rather than silently succeeding. Refund
  out of band and record it manually — including any extra deposits the widget
  lists.
- **Collection endpoints are production-only.** The full initiate → webhook →
  capture path cannot be verified in the Afriex sandbox.
- **Amounts are sent in major units** (`25000` meaning ₦25,000), matching
  `transactions.create`. Confirm this against your own Afriex account before
  going live with real money.
- **Pool references are raw session ids** (`payses_01J...`), which are long and
  contain an underscore. Some banks truncate or strip narration text. If your
  shoppers' banks do, the account-id fallback does not help for pool accounts,
  and the deposit will surface as an unmatched settled event in the log.

## Deployment checklist

- [ ] Plugin and provider both registered in `medusa-config.ts`
- [ ] `AFRIEX_API_KEY`, `AFRIEX_WEBHOOK_PUBLIC_KEY`, and `AFRIEX_ENVIRONMENT` set
- [ ] `npx medusa db:migrate` run
- [ ] Collection method chosen for your volume and repeat rate
- [ ] Exactly one webhook URL registered with Afriex: `/afriex/webhook`
- [ ] Error-level log lines routed somewhere a person will see them (unmatched
      settled deposits, extra deposits, and failed cart completions all land there)
- [ ] Account creation confirmed against your real target countries
- [ ] One live order run end to end before taking real customers

## Development

```bash
pnpm install
pnpm test        # vitest
pnpm typecheck   # tsc --noEmit
pnpm build       # medusa plugin:build
```

Tests cover the invariants that matter rather than that functions return:
one capture per deposit however many times it is delivered, no auto-capture on a
mismatch, nothing read or written before a signature verifies, a settled session
never downgraded by a straggling progress event, a second deposit recorded rather
than lost, and a failed reconciliation releasing its idempotency claim so the
retry still lands.

## License

MIT
