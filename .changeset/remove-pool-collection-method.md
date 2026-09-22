---
"medusa-payment-afriex": minor
---

Remove the experimental `pool` collection method and the `collectionMethod` option. An Afriex pool deposit is confirmed only after a proof of payment is uploaded by hand, so the plugin could never mark such an order paid on its own. Bank transfer now always uses a virtual account created for the order. A `collectionMethod` value left in `medusa-config.ts` is ignored.
