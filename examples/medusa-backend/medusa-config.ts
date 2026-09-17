import { loadEnv, defineConfig } from "@medusajs/framework/utils"

loadEnv(process.env.NODE_ENV || "development", process.cwd())

export default defineConfig({
  projectConfig: {
    databaseUrl: process.env.DATABASE_URL,
    http: {
      storeCors: process.env.STORE_CORS!,
      adminCors: process.env.ADMIN_CORS!,
      authCors: process.env.AUTH_CORS!,
      jwtSecret: process.env.JWT_SECRET || "supersecret",
      cookieSecret: process.env.COOKIE_SECRET || "supersecret",
    },
  },
  // Registering the plugin brings in the webhook route, the admin widget and
  // the idempotency table. Registering only the provider below would give you
  // the payment methods without any of those.
  plugins: ["medusa-payment-afriex"],
  modules: [
    {
      resolve: "@medusajs/payment",
      options: {
        providers: [
          {
            resolve:
              "medusa-payment-afriex/providers/afriex-payment",
            id: "afriex",
            options: {
              apiKey: process.env.AFRIEX_API_KEY,
              environment: process.env.AFRIEX_ENVIRONMENT ?? "staging",
              webhookPublicKey: process.env.AFRIEX_WEBHOOK_PUBLIC_KEY,
              collectionMethod:
                process.env.AFRIEX_COLLECTION_METHOD ?? "dedicated",
              defaultCountryCode: process.env.AFRIEX_DEFAULT_COUNTRY ?? "NG",
            },
          },
        ],
      },
    },
  ],
})
