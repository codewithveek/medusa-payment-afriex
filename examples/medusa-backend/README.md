# Afriex payment example — Medusa backend

A Medusa v2 store wired to `medusa-payment-afriex` through the
workspace, so you can run the plugin end to end without publishing it.

The dependency is declared as `"medusa-payment-afriex": "workspace:*"`,
which pnpm links straight to [`packages/plugin`](../../packages/plugin).
It resolves the plugin's **built** output, so build the plugin before starting
the app — or run `pnpm plugin:dev` from the repo root to keep it rebuilding as
you edit.

## Prerequisites

- Node >= 20.19 and pnpm
- Postgres — `pnpm db:up` starts one with Docker, or point `DATABASE_URL` at your own
- Afriex staging credentials (API key + webhook public key)

## Setup

```bash
# from the repo root
pnpm install
pnpm plugin:build       # Medusa loads the plugin from its built output

cd examples/medusa-backend
cp .env.template .env    # fill in the AFRIEX_* values
pnpm db:up               # Postgres via docker compose (skip if you have your own)
pnpm db:migrate          # also creates the plugin's afriex_processed_webhook table
pnpm seed                # NGN region listing the provider, a product, a key
pnpm dev
```

The admin is then at http://localhost:9000/app. Create your first user with:

```bash
npx medusa user -e admin@example.com -p supersecret
```

## After changing the plugin

`medusa develop` watches this app's `src/`, not the linked plugin's build
output — rebuilding the plugin does not reload the running server. Rebuild, then
restart:

```bash
pnpm plugin:build   # from the repo root
# then restart this app
```

## Receiving webhooks locally

Afriex has to reach your machine, so tunnel port 9000 and register the tunnel
URL once in the Afriex dashboard:

```bash
ngrok http 9000
# register https://<subdomain>.ngrok.app/afriex/webhook
```

Register that path **or** Medusa's generic
`/hooks/payment/pp_afriex_afriex`, never both — the generic one bypasses the
plugin's idempotency store and its amount-mismatch review.

## What the seed covers

Enough for one cart to reach the Afriex payment step and be placed: an NGN
region listing `pp_afriex_afriex`, a sales channel, a stock location, one
product with stock, a flat-rate shipping option, and a publishable key linked to
that sales channel.

It prints that key at the end — use it, not the "Default Sales Channel" key
Medusa creates on its own first boot. Only the seeded key is linked to the
channel the product is published in, so with the other one the product list
comes back empty.

It stops there: no catalogue to browse, no tax rates beyond the system
provider, no customer accounts. Run the stock Medusa starter seed alongside it
if you want a fuller store.

## Storefront

[`../storefront`](../storefront) is a React Router app that walks a cart through
this backend's checkout and shows the shopper's side of the Afriex flow.
