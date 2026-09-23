# medusa-payment-afriex

Get paid in your Medusa store with [Afriex](https://www.afriex.com), two ways.

<p><img src="https://raw.githubusercontent.com/codewithveek/medusa-payment-afriex/main/packages/plugin/medusa-afriex-plugin.png" alt="Medusa Afriex payment plugin" width="100%"></p>

- **Bank transfer.** The shopper gets a bank account number to pay into, right
  in your checkout.
- **Afriex Checkout.** The shopper is sent to a secure Afriex page and pays by
  mobile money or bank transfer, then comes back to your store.

Either way, when the money lands Afriex notifies your store and the order is
marked paid. You turn each method on or off per region. Nothing for you to
reconcile by hand.

[Afriex API docs](https://docs.afriex.com) ·
[Medusa payment docs](https://docs.medusajs.com/resources/commerce-modules/payment) ·
[Example store and storefront](https://github.com/codewithveek/medusa-payment-afriex/tree/main/examples) ·
[Report an issue](https://github.com/codewithveek/medusa-payment-afriex/issues)

## What you get

- **A virtual bank account per order.** Created for the exact order total, shown
  to the shopper with its expiry time, and closed if the cart is abandoned or re-priced.
- **A hosted payment page per order.** Afriex Checkout creates its link only
  once the order is placed, so a cart edit can never leave a payable link for
  the wrong amount, and two clicks on "Pay now" never create two links.
- **Per-region switches.** Turn bank transfer or Afriex Checkout on or off in
  each region, from the region page. Payments already started still complete.
- **Orders that pay themselves.** A verified Afriex webhook authorizes the
  payment, captures it, and completes the cart. Nothing else can mark an order paid.
- **Checkout that does not block.** The shopper can place the order first and
  transfer afterwards. Medusa holds the order as awaiting payment until the money arrives.
- **Wrong amounts caught, not captured.** An underpayment, overpayment, or wrong
  currency is held for review instead of being accepted.
- **No lost money.** A second transfer to a paid order, or a deposit that matches
  no order, is recorded and logged loudly so you can refund it.
- **An admin widget** on the order page: bank account or payment link, expected
  and received amounts, how the shopper paid, the Afriex transaction id, and
  anything that needs your attention.
- **Safe to retry.** Afriex redelivers webhooks. Each event is processed once.

## How it works

**Bank transfer**

1. **Checkout.** The shopper selects bank transfer. The plugin asks Afriex for a
   virtual account and hands your storefront the bank details to display.
2. **Order placed.** The shopper can complete checkout before paying. The order
   is created as _awaiting payment_.
3. **Transfer lands.** Afriex sends a signed webhook. The plugin verifies the
   signature, checks the amount, and marks the order paid.

**Afriex Checkout**

1. **Checkout.** The shopper selects Afriex Checkout. Nothing is sent to Afriex yet.
2. **Order placed.** The order is created as _awaiting payment_.
3. **Pay.** Your storefront asks for the payment link, and the plugin creates it
   with Afriex for that order. The shopper pays on Afriex's page and is sent back
   to your store.
4. **Payment lands.** As for bank transfer: a signed webhook, the amount
   checked, the order marked paid. The return to your store proves nothing by
   itself.

## Before you start

You need:

- A Medusa **v2.21 or newer** application, on **Node 20.19 or newer**, with Postgres.
- An **Afriex Business account** with virtual accounts enabled. Afriex only creates
  virtual accounts in **production**, so you need production access to take a
  real payment. See [Testing](#testing) for what you can do before that.
- A **public HTTPS URL** for your Medusa server, so Afriex can reach the webhook.
  For local work, a tunnel such as [ngrok](https://ngrok.com) is enough.

---

## Setup

Seven steps. Each one ends with what you should see, so you know it worked
before moving on.

### Step 1. Get your two Afriex keys

Sign in to your Afriex Business dashboard.

**The API key.** Go to **Developer → API keys** and create a key. Afriex keys are
permission-scoped, so the key must be allowed to:

| The plugin does this                          | Afriex endpoint                                                       |
| --------------------------------------------- | --------------------------------------------------------------------- |
| Create and close virtual accounts             | `POST /payment-method/virtual-account`, `DELETE /payment-method/{id}` |
| Read a payment method                         | `GET /payment-method/{id}`                                            |
| Register and remove customers                 | `POST /customer`, `DELETE /customer/{id}`                             |
| Create payment links (Afriex Checkout only)   | `POST /checkout-session`                                              |

A key missing a permission fails with `401`, exactly like a wrong key. If
checkout fails with an authentication error and the key looks right, check its
permissions first.

**The webhook public key.** Go to **Developers → Webhooks**. The public key is
shown on that screen. Copy all of it, including the `-----BEGIN PUBLIC KEY-----`
and `-----END PUBLIC KEY-----` lines. You will come back to this screen in Step 6
to enter your webhook URL.

> Staging and production have **different** API keys and **different** webhook
> public keys. Use a matching pair. A production API key with the staging public
> key creates accounts fine and then rejects every webhook.

✅ **You should have:** one API key and one PEM public key, both from the same environment.

### Step 2. Install the plugin

Run this in your Medusa application's directory:

```bash
npm install medusa-payment-afriex
```

✅ **You should see:** `medusa-payment-afriex` under `dependencies` in your `package.json`.

### Step 3. Add your environment variables

In your Medusa app's `.env`:

```bash
AFRIEX_API_KEY=your_api_key
AFRIEX_ENVIRONMENT=production   # or: staging
AFRIEX_WEBHOOK_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqh...\n-----END PUBLIC KEY-----"
```

The public key spans several lines, and environment variables do not like that.
Any of these forms works, because the plugin normalises them:

- One line with `\n` where the line breaks were, in double quotes (shown above).
  This is the form to use in hosting dashboards such as Railway, Render, or Vercel.
- The key pasted as-is across several lines, inside double quotes.

`AFRIEX_ENVIRONMENT` is required. The Afriex SDK silently falls back to
production when it is missing, so the plugin makes you set this explicitly.

For Afriex Checkout, add where Afriex should send the shopper back to. It must
be HTTPS. `{order_id}` is replaced with the order's id:

```bash
AFRIEX_CHECKOUT_RETURN_URL=https://shop.example.com/checkout/afriex/return/{order_id}
```

✅ **You should have:** three `AFRIEX_*` variables set, and a fourth if you offer Afriex Checkout.

### Step 4. Register the plugin and the provider

Both entries are needed. In `medusa-config.ts`:

```ts
module.exports = defineConfig({
  // ...
  plugins: [
    // brings in the webhook route, the admin widget, and the idempotency table
    "medusa-payment-afriex",
  ],
  modules: [
    {
      resolve: "@medusajs/payment",
      options: {
        providers: [
          {
            // brings in the payment provider itself
            resolve: "medusa-payment-afriex/providers/afriex-payment",
            id: "afriex",
            options: {
              apiKey: process.env.AFRIEX_API_KEY,
              environment: process.env.AFRIEX_ENVIRONMENT,
              webhookPublicKey: process.env.AFRIEX_WEBHOOK_PUBLIC_KEY,
              // Only for Afriex Checkout. Leave it out to offer bank transfer only.
              checkout: {
                returnUrl: process.env.AFRIEX_CHECKOUT_RETURN_URL,
              },
            },
          },
        ],
      },
    },
  ],
});
```

This one entry registers **both** payment methods: bank transfer as
`pp_afriex_afriex` and Afriex Checkout as `pp_afriex-checkout_afriex`. Which
ones shoppers see is decided per region in Step 5. Without `checkout.returnUrl`,
Afriex Checkout refuses to start (`AFRIEX_CHECKOUT_NOT_CONFIGURED`) before any
order is placed, and bank transfer is unaffected. Other checkout settings are
under [Options](#options).

Then create the plugin's database tables and start your server:

```bash
npx medusa db:migrate
npm run dev
```

✅ **You should see:** the server start with no Afriex errors. If a key is missing,
malformed, or the environment is wrong, the provider refuses to start and the
error names the option. That is deliberate. It is better than finding out from
a failed payment.

### Step 5. Turn Afriex on for a region

In the Medusa Admin, go to **Settings → Regions** and open the region you sell
in. Below the region's details, the **Afriex payment methods** card has one
switch per method:

| Switch          | Provider id                 |
| --------------- | --------------------------- |
| Bank transfer   | `pp_afriex_afriex`          |
| Afriex Checkout | `pp_afriex-checkout_afriex` |

Medusa's own **⋯ → Edit → Payment Providers** field changes the same setting,
under those ids. The card also says what each method is, and before turning one
off it tells you how many payments in the region are still waiting for money.

**Turning a method off only stops new payments.** A shopper who already has the
bank details or an open payment link can still pay, and the order is still
marked paid. A shopper who chose Afriex Checkout but has not opened the link yet
is asked to choose another option.

> Turn a method off with its switch. Never remove the provider from
> `medusa-config.ts` while orders are waiting on it: Medusa keeps listing it,
> and its payments can no longer be recorded.

The region's currency decides who owns a bank-transfer virtual account. See
[Currencies](#currencies).

✅ **You should see:** the methods you turned on listed under the region's
payment providers, and offered at checkout in that region.

### Step 6. Give Afriex your webhook URL

Back in the Afriex dashboard, under **Developers → Webhooks**, enter:

```
https://your-medusa-server.com/afriex/webhook
```

Locally, run `ngrok http 9000` and use `https://<your-subdomain>.ngrok.app/afriex/webhook`.

> Use this URL and only this URL. Medusa also has a generic
> `/hooks/payment/afriex_afriex` endpoint, which providers like Stripe use. This
> plugin does not, because a bank transfer can arrive in any amount and the
> generic endpoint captures without checking it. The plugin's own route checks
> the amount first, records what arrived, and tells Afriex to retry if anything
> fails. If the generic URL is registered by mistake, each event is refused and
> your Medusa log says so at error level, naming the right URL.

✅ **You should see:** the URL saved in the Afriex dashboard. To prove Afriex can
reach you, see [Testing](#testing).

### Step 7. Connect your storefront

This uses the [Medusa JS SDK](https://docs.medusajs.com/resources/js-sdk). Wire
up the methods you turned on.

#### 7a. Bank transfer

Three things happen in your checkout.

**Start the payment** when the shopper chooses bank transfer:

```ts
const { payment_collection } = await sdk.store.payment.initiatePaymentSession(
  cart,
  {
    provider_id: "pp_afriex_afriex",
  }
);

const session = payment_collection.payment_sessions?.find(
  (s) => s.provider_id === "pp_afriex_afriex"
);
const instructions = session?.data?.instructions;
```

**Show `instructions` to the shopper.** It is plain data, so you decide how to render the UI:

```jsonc
{
  "bankName": "Providus Bank",
  "accountNumber": "0123456789",
  "accountName": "Afriex / Order",
  "note": "This account is reserved for your order only.",
  "expiresNote": "This account expires in 30 minutes — please complete your transfer before then.",
  "expiresInMinutes": 30
}
```

**Place the order.** Do not wait for the money:

```ts
const result = await sdk.store.cart.complete(cart.id);
// result.type === "order", and the order is awaiting payment
```

Then send the shopper to a confirmation page that shows the same bank details
and checks the order every few seconds:

```ts
const { order } = await sdk.store.order.retrieve(orderId, {
  fields: "*payment_collections,*payment_collections.payment_sessions",
});

const collection = order.payment_collections?.[0];
const paid = ["authorized", "captured", "completed"].includes(
  collection?.status ?? ""
);
```

Do not add an "I have paid" button. Nothing the shopper clicks can mark the order
paid. Only Afriex's webhook can.

✅ **You should see:** bank details at checkout, an order created as awaiting
payment, and that order turning paid a few moments after the transfer lands.

A complete working version of this is in
[`examples/storefront`](https://github.com/codewithveek/medusa-payment-afriex/tree/main/examples/storefront).

#### 7b. Afriex Checkout

The payment link is created only after the order is placed, so this takes two
calls on the same payment collection, with the order placed in between.

**Choose the method.** The cart needs an email, and a billing or shipping
address with a phone number. Afriex requires both, and the plugin reads them
from the cart itself:

```ts
await sdk.store.payment.initiatePaymentSession(cart, {
  provider_id: "pp_afriex-checkout_afriex",
});
// Nothing is sent to Afriex yet. session.data.stage === "selected"
```

**Place the order:**

```ts
const result = await sdk.store.cart.complete(cart.id);
// result.type === "order", and the order is awaiting payment
```

**Get the payment link and send the shopper to it.** Use the order's payment
collection that is still `not_paid` or `awaiting`. The same call is your
"Pay now" and "Try again" button on the order page:

```ts
const collection = order.payment_collections?.find((c) =>
  ["not_paid", "awaiting"].includes(c.status)
);

const { payment_collection } = await sdk.client.fetch(
  `/store/payment-collections/${collection.id}/payment-sessions`,
  { method: "POST", body: { provider_id: "pp_afriex-checkout_afriex" } }
);

const session = payment_collection.payment_sessions?.find(
  (s) => s.provider_id === "pp_afriex-checkout_afriex"
);
window.location.href = session.data.checkoutUrl;
```

Afriex sends the shopper back to your `returnUrl`. Show the order page from
there, checking every few seconds as for bank transfer. Coming back does not
mean the shopper paid. Only the webhook marks the order paid.

**To narrow what shoppers are offered on Afriex's page**, without touching
`medusa-config.ts`:

```bash
curl -X POST https://your-medusa-server.com/admin/afriex/settings \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"checkout_channels": ["MOBILE_MONEY"], "hide_bank_channel_where_bank_transfer": true}'
```

`hide_bank_channel_where_bank_transfer` drops Afriex's own bank transfer in
regions where you already offer the plugin's — but only where `currencyChannels`
shows the currency can be paid another way, so a shopper is never left with
nothing. If Afriex then refuses the payment, the plugin asks again with the bank
option restored and says so in your log.

What the order page can read from `session.data`: `stage` (`"selected"` or
`"open"`), `checkoutUrl`, `expiresAtEstimate`, `currentStatus`,
`failureReason.message` after a failed attempt, and `paidChannel` once paid.

The plugin ignores everything your storefront puts in `data` except
`return_url`. That is a return URL for this payment, and it is accepted only on
the origin of `returnUrl` or one listed in `allowedReturnOrigins`.

**Refusals** come back as `{ code, message }`. Branch on the code:

| Code                                       | HTTP | When                                                              | What to do                                                    |
| ------------------------------------------ | ---- | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `AFRIEX_CHECKOUT_EMAIL_REQUIRED`           | 400  | Choosing the method; the cart has no email                        | Ask for an email                                              |
| `AFRIEX_CHECKOUT_PHONE_REQUIRED`           | 400  | Choosing the method; no usable phone number                       | Ask for a phone number with its country                       |
| `AFRIEX_CHECKOUT_NOT_CONFIGURED`           | 400  | `checkout.returnUrl` is not set, or Afriex refused the request for your store | Hide the method. Your log says which                          |
| `AFRIEX_RETURN_URL_NOT_ALLOWED`            | 400  | Your `return_url` is not on an allowed origin                     | Developer error                                               |
| `AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY` | 400  | The currency or amount cannot be paid this way                    | Offer another method                                          |
| `AFRIEX_PAYMENT_IN_PROGRESS`               | 409  | A payment link is still open, a payment is moving, or it was paid | Offer the `checkout_url` in the response; retry after `retry_after` |
| `AFRIEX_ORDER_NOT_PAYABLE`                 | 400  | The order is cancelled or already paid                            | Show the order's state                                        |
| `AFRIEX_METHOD_UNAVAILABLE`                | 400  | The method was turned off for the region after the order was placed | Offer the other methods                                     |
| `AFRIEX_CHECKOUT_REFUSED`                  | 400  | Afriex refused the payment link                                   | Show `message`; offer another method                          |
| `AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE`  | 500  | Afriex could not be reached or failed, or the reference was already in use | "Please try again". The order keeps waiting                   |

✅ **You should see:** the order placed as awaiting payment, the shopper sent to
Afriex's page, and the order turning paid shortly after they pay.

---

## Testing

Afriex creates virtual accounts in production only, so there are three levels of
testing, from free to real.

**1. Can Afriex reach me, and is my key right?** Works in staging. Ask Afriex to
fire a signed test event at your registered webhook URL:

```bash
curl -X POST https://sandbox.api.afriex.com/api/v1/webhooks/trigger \
  -H "x-api-key: $AFRIEX_API_KEY" -H "Content-Type: application/json" \
  -d '{"event": "TRANSACTION.UPDATED", "entityId": "<any transaction id from your sandbox>"}'
```

Your Medusa log will show the event arriving. A `200` means the signature
verified. It will say the session is unknown, which is correct for a test event.
A `401` means your public key does not match the environment.

**2. Does the whole order flow work, without moving money?** The repository
includes a webhook simulator that signs events with a throwaway key, so you can
pay, underpay, and double-pay an order on your own machine, by bank transfer or
through Afriex Checkout (`--channel MOBILE_MONEY`). A second script walks a
checkout order through your store's API: choose the method, place the order,
ask for the link. See
[Testing without real money](https://github.com/codewithveek/medusa-payment-afriex#testing-without-real-money).

**3. One real order.** With production keys, place an order for a small amount
and pay it. Watch the order turn paid and check the admin widget. Do this once
before you take real customers.

---

## Options

| Option               | Description                                                                         | Required | Default       |
| -------------------- | ----------------------------------------------------------------------------------- | -------- | ------------- |
| `apiKey`             | Your Afriex API key.                                                                | Yes      |               |
| `environment`        | `"staging"` or `"production"`. Must match where the keys came from.                 | Yes      |               |
| `webhookPublicKey`   | Afriex's PEM public key, used to verify every webhook.                              | Yes      |               |
| `defaultCountryCode` | Two-letter country used when the shopper has no saved billing address.              | No       | `"NG"`        |
| `checkout`           | Afriex Checkout settings, below. Leave it out to offer bank transfer only.          | No       |               |

**`checkout`**

| Option                 | Description                                                                                                                             | Default                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `returnUrl`            | Where Afriex sends the shopper back to. HTTPS. `{order_id}` in the path is replaced with the order's id. Checkout refuses to start without it. |                            |
| `allowedReturnOrigins` | Other HTTPS origins, like `"https://shop.example.com"`, that a storefront's `return_url` may use.                                       | `[]`                       |
| `channels`             | The most checkout may offer: `VIRTUAL_BANK_ACCOUNT`, `MOBILE_MONEY`, `CARD`. `CARD` is not sent yet: the Afriex SDK does not accept it. | All of them                |
| `currencyChannels`     | Optional. What each currency can collect, like `{ NGN: ["VIRTUAL_BANK_ACCOUNT"], GHS: ["MOBILE_MONEY"] }`. A currency listed with nothing in common with `channels` is refused before the order is placed. |                            |
| `minorUnitExponents`   | Decimal places Afriex uses for a currency that does not have two, like `{ XOF: 0 }`. Such a currency is refused until you set it, because a wrong guess charges 100× too much or too little. |                            |

## Currencies

Afriex opens a virtual account **for a customer** in NGN only. The plugin follows that:

| Region currency                                    | Who owns the virtual account                                        |
| -------------------------------------------------- | ------------------------------------------------------------------- |
| NGN, and the shopper has an email and phone number | The shopper, registered with Afriex once and reused on later orders |
| NGN, shopper has no phone number (most guests)     | Your business                                                       |
| Any other currency                                 | Your business                                                       |

Either way the shopper sees an account to pay into and the order is matched the
same way. Whether Afriex can open a business virtual account in a given currency
depends on your Afriex account, so confirm that for each currency you sell in.

Afriex limits how many virtual accounts can be open at once per customer and
currency. The plugin closes an account when its payment is cancelled, when
Medusa deletes the payment session (an abandoned or changed cart), and when a
new total needs a new account. An account that was paid into simply expires on
Afriex's schedule. If you see `VIRTUAL_ACCOUNT_LIMIT_REACHED`, ask Afriex about
your limit.

## How a deposit is matched to its order

Every order gets its own virtual account, created for the exact total. The
shopper needs no reference, and a deposit is matched to its order two
independent ways: by the reference the plugin set, and by the account the money
landed in.

An Afriex Checkout payment is matched by the reference the plugin gave its link,
which Afriex echoes on the transaction. Each link gets a new reference, so a
retry never reuses one.

## Payment statuses

| Afriex says                                                                    | Medusa session becomes | What happens                                  |
| ------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------- |
| `PENDING`, `PROCESSING`, `RETRY`, `SCHEDULED`                                  | `pending`              | Noted. The order keeps waiting.               |
| `SUCCESS`                                                                      | `captured`             | Amount checked, payment captured, order paid. |
| `FAILED`, `REJECTED`                                                           | `error`                | Noted. The order stays unpaid.                |
| `CANCELLED`                                                                    | `canceled`             | Noted.                                        |
| `IN_REVIEW`, `CUSTOMER_ACTION_REQUIRED`, `REFUNDED`, `UNKNOWN`, any `DISPUTE*` | `requires_more`        | Flagged for a person.                         |
| Anything else                                                                  | `pending`              | Never confirms an order, never fails one.     |

For Afriex Checkout, `CUSTOMER_ACTION_REQUIRED` means the shopper is approving
a mobile-money prompt or entering a code, so it stays `pending` and is not
flagged.

Once an order has settled, a late or out-of-order `PROCESSING` event cannot
un-pay it.

## When things do not go to plan

**The amount is wrong.** A settled transfer that is short, over, or in the wrong
currency is not captured. The session moves to `requires_more`, and the admin
widget shows expected against received so you can decide what to do.

**The shopper pays twice.** The second transfer is recorded as an _extra deposit_
with its transaction id, logged at error level, and listed in the admin widget as
needing a refund. The same happens to a wrong-amount transfer that the shopper
then corrects with a second one.

**The order was cancelled before the money arrived.** Cancelling an order that is
still waiting for payment does not close its payment session, so the shopper can
still pay. That money is not captured, because capturing would mark a cancelled
order paid. The session moves to `requires_more` with the status
`SETTLED_AFTER_CANCEL`, the error log says a refund is needed, and the admin
widget shows the amount to refund.

**The order total changed after the shopper was asked to pay.** An admin order
edit, claim or exchange changes the order's total but not the account the shopper
was given. A transfer for the old total is not captured. The session moves to
`requires_more` with the status `COLLECTION_AMOUNT_CHANGED`, and the admin widget
shows what arrived so you can settle the difference by hand.

**The shopper pays an account or link after its session was replaced.** Medusa
deletes a payment session when the cart total changes or the shopper picks
another method, and the account or link they were shown may still receive
money. The plugin keeps a record of every account and link it hands out, so that
money is traced back to its order. If the order has exactly one unpaid Afriex
payment, for exactly that amount, the plugin applies it there and captures it.
If anything is less than certain, it is _held_ against the order and logged at
error level: apply it or refund it (see below).

**An Afriex Checkout attempt fails, or the link expires.** The order keeps
waiting. The failure reason is kept on the session for your storefront and the
admin widget, and the shopper can ask for a new link. While a link is still
open, or a payment through it is still moving, a new one is refused with
`AFRIEX_PAYMENT_IN_PROGRESS` and the open link, so a shopper is never charged
through two links. If a bank transfer on Afriex's page fails, the widget warns
that the shopper may have sent a different amount. Check your Afriex dashboard
before asking them to pay again.

**A deposit matches no order at all.** It is acknowledged so Afriex stops
retrying, and changes nothing. If that deposit had _settled_, it is logged at
error level, because that is money you hold with no order attached.

**Something fails on your side.** If the database is down, or the payment was
captured but the cart would not complete into an order, the plugin answers `500`.
Afriex retries for up to about a day and a half, and each attempt is logged at
error level.

Send error-level logs somewhere a person will see them. Every case above that
needs a human ends up there.

## Settling money the plugin held back

Medusa's own **Mark as paid** cannot settle these orders: it only works on a
payment collection nobody has started paying, and these ones are _awaiting_.
The plugin adds two admin API routes instead. Call them as an admin user (a
session cookie, a bearer token, or a secret API key). Each log line gives you the
ids to use.

**A deposit held on its session** (`AMOUNT_MISMATCH`, `COLLECTION_AMOUNT_CHANGED`,
`SETTLED_AFTER_CANCEL`):

```bash
# Accept it as payment in full. Confirm the amount that arrived.
curl -X POST https://your-medusa-server.com/admin/afriex/sessions/payses_01.../resolve \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action": "accept", "received_amount": "24950"}'

# Or record it as money to refund, and let the shopper pay again.
curl -X POST https://your-medusa-server.com/admin/afriex/sessions/payses_01.../resolve \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"action": "refund"}'
```

Accepting captures the order total. Anything that arrived beyond it is listed in
the admin widget as needing a refund. A deposit that arrived after the order was
cancelled can only be refunded.

**A late payment held against an old reference:**

```bash
curl -X POST https://your-medusa-server.com/admin/afriex/references/payses_01.../apply \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"transaction_id": "txn_..."}'
```

This records the payment on the order's current Afriex session and captures it.
If the amount differs from what the order now expects, the call is refused until
you add `"confirm_amount": true`.

Refunds themselves are made from your Afriex dashboard. Every refusal comes back
with a `code` and a plain-language `message`.

## Troubleshooting

| What you see                                                                              | Likely cause                                                                                                                                                         | Fix                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Server will not start: _`environment` is required_ or _must be "staging" or "production"_ | `AFRIEX_ENVIRONMENT` is missing or misspelled                                                                                                                        | Set it to exactly `staging` or `production`.                                                                                    |
| Server will not start: _`webhookPublicKey` is not a valid public key_                     | The key was cut short, or the `BEGIN`/`END` lines are missing                                                                                                        | Copy the whole key again and wrap it in double quotes.                                                                          |
| Bank transfer fails at checkout: _Afriex payment initiation failed_                      | Using staging keys (virtual accounts are production-only), a key without the right permissions, or a currency or country your Afriex account cannot open accounts in | The real Afriex error is in your Medusa log, at error level.                                                                    |
| Webhook returns `401`                                                                     | The public key is from the other environment, or a proxy is rewriting the request body                                                                               | Use the public key that matches your API key's environment. Make sure nothing between Afriex and Medusa re-serialises the JSON. |
| Webhook returns `404`                                                                     | The plugin is registered as a provider but not under `plugins`                                                                                                       | Add `"medusa-payment-afriex"` to `plugins`, as in Step 4.                                                                       |
| Webhook returns `200` with `unknown_session`, order stays unpaid                          | The event is for something else, or for a payment session Medusa has since deleted because the cart changed                                                          | Check the log line for the transaction id. If it says the deposit has settled, that money needs matching by hand.               |
| Order stays unpaid, and the log says an event _arrived on Medusa's generic /hooks/payment endpoint_ | Medusa's generic webhook URL was registered with Afriex instead of the plugin's | Replace it with `https://your-server/afriex/webhook`, as in Step 6. Events sent to the wrong URL were refused, not queued, so check those orders by hand. |
| Order stays unpaid and no webhook arrives                                                 | Afriex cannot reach your server, or the URL was saved in the other environment's dashboard                                                                           | Re-check Step 6. Test with level 1 under [Testing](#testing).                                                                   |
| Afriex is missing from the region's provider list                                         | The provider did not load                                                                                                                                            | Check Step 4 and the server's startup log.                                                                                      |
| A method is not offered at checkout                                                       | It is not turned on for the cart's region                                                                                                                            | Turn it on in the region's **Afriex payment methods** card (Step 5).                                                            |
| Choosing Afriex Checkout fails with `AFRIEX_CHECKOUT_NOT_CONFIGURED`                      | `checkout.returnUrl` is not set                                                                                                                                      | Set it (Steps 3 and 4) and restart.                                                                                             |
| "Pay now" always fails with `AFRIEX_CHECKOUT_TEMPORARILY_UNAVAILABLE`                     | Afriex answered `401`: a wrong key, or a key without permission to create checkout sessions. Or Afriex is unreachable                                                | The Medusa log says which. Check the key's permissions (Step 1).                                                                |
| "Pay now" fails with `AFRIEX_CHECKOUT_NOT_CONFIGURED` although `returnUrl` is set         | Afriex answered `403` or `404`: the endpoint is not there for your store                                                                                             | Update the plugin and `@afriex/sdk`, and check with Afriex that your account can create checkout sessions. Turn the method off meanwhile. |
| Shoppers are only offered a bank transfer on the Afriex page                              | Afriex offers only what the currency can collect. In NGN that is the virtual account; mobile money is dropped                                                        | Nothing to fix. The order widget shows the options Afriex actually offered.                                                     |

## Limitations

- **No refunds through Medusa.** Refunding from the admin throws an error rather
  than pretending to succeed. Refund from Afriex and record it on the order.
- **Production-only accounts.** The full bank-transfer flow cannot run against
  Afriex's sandbox.
- **Amounts.** Bank transfer amounts are in major units: `25000` means ₦25,000.
  Afriex Checkout takes minor units, and the plugin converts (₦25,000 is sent as
  `2500000`). Confirm both with one small real order before going live.
- **No card payments yet.** Afriex Checkout offers mobile money and bank
  transfer. The Afriex SDK does not accept `CARD` yet, so the plugin does not send it.
- **A checkout link's expiry is estimated.** Afriex does not say when a link
  expires in its reply, so the plugin assumes 15 minutes.

## Going live

- [ ] Production API key and production webhook public key, from the same dashboard
- [ ] `AFRIEX_ENVIRONMENT=production`
- [ ] `"medusa-payment-afriex"` under `plugins` **and** the provider under `@medusajs/payment`
- [ ] `npx medusa db:migrate` run on the production database
- [ ] The methods you want turned on in every region you sell in
- [ ] For Afriex Checkout: `checkout.returnUrl` points at your live storefront,
      and the API key may create checkout sessions
- [ ] `https://your-server/afriex/webhook` saved in the **production** Afriex dashboard, and no other URL
- [ ] Error-level logs go somewhere a person will see them
- [ ] If you run more than one Medusa server instance, a shared
      [locking provider](https://docs.medusajs.com/resources/infrastructure-modules/locking)
      (Redis or Postgres) is configured. The plugin locks each order's payment
      while it records a deposit. Medusa's default lock only works inside one
      process. (Even without it, a database constraint stops an order being
      captured twice, but a second deposit then needs a webhook retry to be
      recorded.)
- [ ] One real, small order placed and paid end to end with each method, and
      with each Afriex Checkout option you offer

## What the plugin adds to your Medusa app

| Piece            | What it is                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| Payment providers | `pp_afriex_afriex` (bank transfer) and `pp_afriex-checkout_afriex` (Afriex Checkout), each turned on per region |
| API route        | `POST /afriex/webhook`                                                      |
| Middleware       | On `POST /store/payment-collections/:id/payment-sessions` and its admin twin: stops a payment in progress being replaced, and builds Afriex Checkout's request on the server |
| Admin API routes | `GET` and `POST /admin/afriex/regions/:id/methods`, `GET` and `POST /admin/afriex/settings`, `POST /admin/afriex/sessions/:id/resolve`, `POST /admin/afriex/references/:reference/apply` |
| Database tables  | `afriex_processed_webhook` (each webhook is handled once), `afriex_payment_reference` (every account and link handed out), `afriex_settlement` (one capture per order), `afriex_setting` (your store-wide choices) |
| Subscriber       | Records each account and payment link the providers hand out                |
| Scheduled job    | Nightly at 03:00, removes processed-webhook rows older than 90 days         |
| Admin widgets    | On the order details page, and on the region details page                   |

No Redis and no extra services. Everything lives in your Medusa database.

## Contributing and support

Bugs and requests: [open an issue](https://github.com/codewithveek/medusa-payment-afriex/issues).
To work on the plugin, the [repository README](https://github.com/codewithveek/medusa-payment-afriex#readme)
covers running the example store, the tests, and the webhook simulator.

Built on [`@afriex/sdk`](https://www.npmjs.com/package/@afriex/sdk).

## License

MIT
