import { defineMiddlewares } from "@medusajs/framework/http"
import { AFRIEX_WEBHOOK_PATH } from "../lib/constants"

/**
 * The signature covers the exact bytes Afriex sent, so the route needs the raw
 * body — a re-serialized JSON object will not verify.
 */
export default defineMiddlewares({
  routes: [
    {
      method: ["POST"],
      bodyParser: { preserveRawBody: true },
      matcher: AFRIEX_WEBHOOK_PATH,
    },
  ],
})
