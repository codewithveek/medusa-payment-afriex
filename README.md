# medusa-payment-afriex

<p dir="auto"><a target="_blank" rel="noopener noreferrer nofollow" href="./packages/plugin/medusa-afriex-plugin.png"><img src="./packages/plugin/medusa-afriex-plugin.png" alt="Medusa Afriex Plugin" style="max-width: 100%;"></a></p>

A Medusa v2 payment provider that lets a storefront collect payment through
Afriex's bank rails — a **dedicated virtual account** minted per order, or a
standing **pool account** the shopper quotes a reference against. Deposits are
confirmed by webhook, and the order is completed from that webhook alone.

**📖 Full plugin documentation lives in
[`packages/plugin/README.md`](./packages/plugin/README.md).**

---

## Repository layout

This is a pnpm workspace.

```
packages/
  plugin/            medusa-payment-afriex — the published npm package
examples/
  medusa-backend/    a Medusa store wired to the plugin via workspace:*
  storefront/        a React Router shop that walks a cart through the checkout
```

Examples live outside `packages/` on purpose: they are private apps that consume
the plugin exactly the way an installing project would, and they are never
published.

## Working on the plugin

```bash
pnpm install          # installs every workspace at once
pnpm build            # turbo: builds the plugin, then anything depending on it
pnpm test             # vitest, across the workspace
pnpm typecheck
```

Scoped to a single workspace:

```bash
pnpm --filter medusa-payment-afriex test
pnpm plugin:dev       # medusa plugin:develop, rebuilds the plugin on change
pnpm backend:dev      # runs examples/medusa-backend against that build
pnpm storefront:dev   # runs examples/storefront against that backend
```

The examples depend on `"medusa-payment-afriex": "workspace:*"`, which pnpm
links to the local package. Medusa resolves the plugin from its built
`.medusa/server` output, so the plugin has to be built — `pnpm plugin:dev` keeps
that output fresh while you edit.

Note that `medusa develop` watches the backend's own `src/`, not the linked
plugin's build output, so restart the backend after a plugin rebuild.

## Seeing it work

Three terminals, in this order:

```bash
pnpm plugin:dev                          # keeps the plugin build fresh
cd examples/medusa-backend && pnpm dev    # after db:up, db:migrate, seed
cd examples/storefront    && pnpm dev     # http://localhost:8000
```

[`examples/medusa-backend/README.md`](./examples/medusa-backend/README.md) covers
database setup, seeding and webhook tunnelling;
[`examples/storefront/README.md`](./examples/storefront/README.md) covers the
checkout the shopper walks through.

## Releasing

Versioning goes through [changesets](https://github.com/changesets/changesets):

```bash
pnpm changeset          # describe the change, pick a bump
pnpm version-packages   # apply bumps and update changelogs
pnpm release            # build the workspace packages and publish
```

Only `packages/*` is published. `examples/*` is marked private.

## License

MIT — see [LICENSE](./LICENSE).
