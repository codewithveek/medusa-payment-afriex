import { redirect } from "react-router"
import type { Route } from "./+types/afriex-return"

/**
 * Where Afriex sends the shopper back to (`checkout.returnUrl` in the backend's
 * config, with `{order_id}` in the path).
 *
 * Coming back proves nothing: the shopper may have closed the page, or the
 * payment may still be settling. So this never marks anything paid. It hands
 * over to the order page, which says it is checking and waits for the webhook.
 */
export function loader({ params }: Route.LoaderArgs) {
  return redirect(`/order/${params.orderId}?returned=1`)
}
