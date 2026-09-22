import { defineMiddlewares } from "@medusajs/framework/http"
import { AFRIEX_WEBHOOK_PATH } from "../lib/constants"
import { afriexPaymentSessionGuard } from "../lib/payment-session-guard"

export default defineMiddlewares({
  routes: [
    {
      // The signature covers the exact bytes Afriex sent, so the route needs
      // the raw body — a re-serialized JSON object will not verify.
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
      matcher: AFRIEX_WEBHOOK_PATH,
    },
    {
      // Creating a payment session deletes every other session on the
      // collection, so this guards the route whichever provider is asked for.
      method: ["POST"],
      matcher: "/store/payment-collections/:id/payment-sessions",
      middlewares: [afriexPaymentSessionGuard],
    },
    {
      method: ["POST"],
      matcher: "/admin/payment-collections/:id/payment-sessions",
      middlewares: [afriexPaymentSessionGuard],
    },
  ],
})
