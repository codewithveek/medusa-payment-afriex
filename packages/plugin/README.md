# medusa-payment-afriex

Accept bank transfers in your Medusa store with [Afriex](https://www.afriex.com).

<p><img src="https://raw.githubusercontent.com/codewithveek/medusa-payment-afriex/main/packages/plugin/medusa-afriex-plugin.png" alt="Medusa Afriex payment plugin" width="100%"></p>

Your shopper picks Afriex at checkout and gets a bank account number to pay
into. When the transfer lands, Afriex tells your store, and the order is marked
paid. No card form, no redirect, nothing for you to reconcile by hand.

[Afriex API docs](https://docs.afriex.com) ·
[Medusa payment docs](https://docs.medusajs.com/resources/commerce-modules/payment) ·
[Example store and storefront](https://github.com/codewithveek/medusa-payment-afriex/tree/main/examples) ·
[Report an issue](https://github.com/codewithveek/medusa-payment-afriex/issues)

## What you get

- **A virtual bank account per order.** Created for the exact order total, shown
  to the shopper with its expiry time, and closed if the cart is abandoned or re-priced.
- **Orders that pay themselves.** A verified Afriex webhook authorizes the
  payment, captures it, and completes the cart. Nothing else can mark an order paid.
- **Checkout that does not block.** The shopper can place the order first and
  transfer afterwards. Medusa holds the order as awaiting payment until the money arrives.
- **Wrong amounts caught, not captured.** An underpayment, overpayment, or wrong
  currency is held for review instead of being accepted.
- **No lost money.** A second transfer to a paid order, or a deposit that matches
  no order, is recorded and logged loudly so you can refund it.
- **An admin widget** on the order page: bank account, expected and received
  amounts, Afriex transaction id, and anything that needs your attention.
- **Safe to retry.** Afriex redelivers webhooks. Each event is processed once.

## How it works

1. **Checkout.** The shopper selects Afriex. The plugin asks Afriex for a virtual
   account and hands your storefront the bank details to display.
2. **Order placed.** The shopper can complete checkout before paying. The order
   is created as _awaiting payment_.
3. **Transfer lands.** Afriex sends a signed webhook. The plugin verifies the
   signature, checks the amount, and marks the order paid.

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
| Read the pool account, only if you use `pool` | `GET /payment-method/pool-account`                                    |

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
production when it is missing, so the plugin makes you say it out loud.

✅ **You should have:** three `AFRIEX_*` variables set.

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
            },
          },
        ],
      },
    },
  ],
});
```

Then create the plugin's one database table and start your server:

```bash
npx medusa db:migrate
npm run dev
```

✅ **You should see:** the server start with no Afriex errors. If a key is missing,
malformed, or the environment is wrong, the provider refuses to start and the
error names the option. That is deliberate. It is better than finding out from
a failed payment.

### Step 5. Turn Afriex on for a region

In the Medusa Admin:

1. Go to **Settings → Regions** and open the region you sell in.
2. Click the **⋯** menu, then **Edit**.
3. In **Payment Providers**, select the Afriex provider. Its id is `pp_afriex_afriex`.
4. **Save**.

The region's currency decides who owns the virtual account. See
[Currencies](#currencies).

✅ **You should see:** Afriex listed under the region's payment providers.

### Step 6. Give Afriex your webhook URL

Back in the Afriex dashboard, under **Developers → Webhooks**, enter:

```
https://your-medusa-server.com/afriex/webhook
```

Locally, run `ngrok http 9000` and use `https://<your-subdomain>.ngrok.app/afriex/webhook`.

> Use this URL and only this URL. Every Medusa server also has a generic
> `/hooks/payment/afriex_afriex` endpoint. It does **not** work for this
> provider. Events sent there are verified and then go nowhere.

✅ **You should see:** the URL saved in the Afriex dashboard. To prove Afriex can
reach you, see [Testing](#testing).

### Step 7. Show the bank details in your storefront

Three things happen in your checkout. This uses the
[Medusa JS SDK](https://docs.medusajs.com/resources/js-sdk).

**Start the payment** when the shopper chooses Afriex:

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

**Show `instructions` to the shopper.** It is plain data, so you decide how it looks:

```jsonc
{
  "bankName": "Providus Bank",
  "accountNumber": "0123456789",
  "accountName": "Afriex / Order",
  "note": "This account is reserved for your order only. No reference needed.",
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
pay, underpay, and double-pay an order on your own machine. See
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
| `collectionMethod`   | `"dedicated"` for a virtual account per order. `"pool"` is experimental, see below. | No       | `"dedicated"` |
| `defaultCountryCode` | Two-letter country used when the shopper has no saved billing address.              | No       | `"NG"`        |

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

## Collection methods

**`dedicated` (default, recommended).** One virtual account per order, created for
the exact total. The shopper needs no reference, and a deposit is matched to its
order two independent ways: by the reference the plugin set, and by the account
the money landed in.

**`pool` (experimental, do not use for real orders yet).** Afriex's pool account is
one shared account for your whole business. Afriex attributes each deposit using
a `reference` that **Afriex assigns** and returns with the account. A reference
you supply is accepted but ignored. This plugin currently tries to match pool
deposits by the Medusa payment session id, which Afriex never receives, so a
pool deposit cannot yet be tied back to its order. With `pool` selected, the
shopper is shown the pool account, but nothing will mark the order paid
automatically. It is kept behind an option for testing, and matching on Afriex's
own reference is planned for a later version.

## Payment statuses

| Afriex says                                                                    | Medusa session becomes | What happens                                  |
| ------------------------------------------------------------------------------ | ---------------------- | --------------------------------------------- |
| `PENDING`, `PROCESSING`, `RETRY`, `SCHEDULED`                                  | `pending`              | Noted. The order keeps waiting.               |
| `SUCCESS`                                                                      | `captured`             | Amount checked, payment captured, order paid. |
| `FAILED`, `REJECTED`                                                           | `error`                | Noted. The order stays unpaid.                |
| `CANCELLED`                                                                    | `canceled`             | Noted.                                        |
| `IN_REVIEW`, `CUSTOMER_ACTION_REQUIRED`, `REFUNDED`, `UNKNOWN`, any `DISPUTE*` | `requires_more`        | Flagged for a person.                         |
| Anything else                                                                  | `pending`              | Never confirms an order, never fails one.     |

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

**A deposit matches no order.** It is acknowledged so Afriex stops retrying, and
changes nothing. If that deposit had _settled_, it is logged at error level,
because that is money you hold with no order attached.

**Something fails on your side.** If the database is down, or the payment was
captured but the cart would not complete into an order, the plugin answers `500`.
Afriex retries for up to about a day and a half, and each attempt is logged at
error level.

Send error-level logs somewhere a person will see them. Every case above that
needs a human ends up there.

## Troubleshooting

| What you see                                                                              | Likely cause                                                                                                                                                         | Fix                                                                                                                             |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Server will not start: _`environment` is required_ or _must be "staging" or "production"_ | `AFRIEX_ENVIRONMENT` is missing or misspelled                                                                                                                        | Set it to exactly `staging` or `production`.                                                                                    |
| Server will not start: _`webhookPublicKey` is not a valid public key_                     | The key was cut short, or the `BEGIN`/`END` lines are missing                                                                                                        | Copy the whole key again and wrap it in double quotes.                                                                          |
| Checkout fails: _Afriex payment initiation failed_                                        | Using staging keys (virtual accounts are production-only), a key without the right permissions, or a currency or country your Afriex account cannot open accounts in | The real Afriex error is in your Medusa log, at error level.                                                                    |
| Webhook returns `401`                                                                     | The public key is from the other environment, or a proxy is rewriting the request body                                                                               | Use the public key that matches your API key's environment. Make sure nothing between Afriex and Medusa re-serialises the JSON. |
| Webhook returns `404`                                                                     | The plugin is registered as a provider but not under `plugins`                                                                                                       | Add `"medusa-payment-afriex"` to `plugins`, as in Step 4.                                                                       |
| Webhook returns `200` with `unknown_session`, order stays unpaid                          | The event is for something else, or for a payment session Medusa has since deleted because the cart changed                                                          | Check the log line for the transaction id. If it says the deposit has settled, that money needs matching by hand.               |
| Order stays unpaid and no webhook arrives                                                 | Afriex cannot reach your server, or the URL was saved in the other environment's dashboard                                                                           | Re-check Step 6. Test with level 1 under [Testing](#testing).                                                                   |
| Afriex is missing from the region's provider list                                         | The provider did not load                                                                                                                                            | Check Step 4 and the server's startup log.                                                                                      |

## Limitations

- **No refunds through Medusa.** Refunding from the admin throws an error rather
  than pretending to succeed. Refund from Afriex and record it on the order.
- **`pool` is experimental** and will not mark orders paid. See [Collection methods](#collection-methods).
- **Production-only accounts.** The full flow cannot run against Afriex's sandbox.
- **Amounts are in major units.** `25000` means ₦25,000. Confirm this matches your
  Afriex account with one small real order before going live.

## Going live

- [ ] Production API key and production webhook public key, from the same dashboard
- [ ] `AFRIEX_ENVIRONMENT=production`
- [ ] `"medusa-payment-afriex"` under `plugins` **and** the provider under `@medusajs/payment`
- [ ] `npx medusa db:migrate` run on the production database
- [ ] Afriex enabled in every region you sell in
- [ ] `https://your-server/afriex/webhook` saved in the **production** Afriex dashboard, and no other URL
- [ ] Error-level logs go somewhere a person will see them
- [ ] One real, small order placed and paid end to end

## What the plugin adds to your Medusa app

| Piece            | What it is                                                                  |
| ---------------- | --------------------------------------------------------------------------- |
| Payment provider | `pp_afriex_afriex`, selectable per region                                   |
| API route        | `POST /afriex/webhook`                                                      |
| Database table   | `afriex_processed_webhook`, which makes webhook handling run once per event |
| Scheduled job    | Nightly at 03:00, removes processed-webhook rows older than 90 days         |
| Admin widget     | On the order details page                                                   |

No Redis and no extra services. Everything lives in your Medusa database.

## Contributing and support

Bugs and requests: [open an issue](https://github.com/codewithveek/medusa-payment-afriex/issues).
To work on the plugin, the [repository README](https://github.com/codewithveek/medusa-payment-afriex#readme)
covers running the example store, the tests, and the webhook simulator.

Built on [`@afriex/sdk`](https://www.npmjs.com/package/@afriex/sdk).

## License

MIT
