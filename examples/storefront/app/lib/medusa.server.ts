import Medusa from "@medusajs/js-sdk"

/**
 * Server-only Medusa client. Every call in this app runs inside a loader or an
 * action, so the publishable key stays on the server.
 */
export const medusa = new Medusa({
  baseUrl: process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000",
  publishableKey: requireEnv("MEDUSA_PUBLISHABLE_KEY"),
})

/** The provider id Medusa stores: `pp_<identifier>_<config id>`. */
export const AFRIEX_PROVIDER_ID = "pp_afriex_afriex"

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `${name} is not set. Copy .env.template to .env and fill it in — the ` +
        `publishable key is printed by \`pnpm seed\` in examples/medusa-backend.`
    )
  }
  return value
}
