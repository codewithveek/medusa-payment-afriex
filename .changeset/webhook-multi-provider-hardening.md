---
"medusa-payment-afriex": patch
---

Harden webhook reconciliation. **Run `npx medusa db:migrate` after upgrading**: the processed-webhook table gains a `completed_at` column.

- A webhook is now checked against every Afriex provider registration, and accepted when the session's own provider is one of those that verified it. Previously the first registration that verified won, so a second Afriex provider sharing the same webhook key had its payments refused with `401`.
- Deposits for one payment session are now recorded one at a time, capture included, under a lock. Before, two different transfers settling at the same moment could both be captured, and one of them was never recorded as money to refund.
- A redelivery that arrives while the first delivery of the same event is still being processed now gets a retryable `503` instead of `200 duplicate`. Before, if that first attempt then failed, Afriex had already stopped retrying and the deposit was never recorded. A claim left behind by a crashed process is taken over after five minutes.
- A deposit that settles after its order was cancelled is no longer captured. It is recorded as `SETTLED_AFTER_CANCEL`, logged at error level, and shown in the admin widget as needing a refund. A capture that races an admin cancelling the order is flagged the same way. The check reads the order, not only the payment collection, because Medusa can recompute a cancelled collection back to `awaiting`.
- A deposit that settles after an admin changed the order total (order edit, claim or exchange) is no longer captured at the old total. It is recorded as `COLLECTION_AMOUNT_CHANGED` for review.
- A deposit on a session whose payment collection was already paid through another session is recorded as an extra deposit to refund, not captured a second time.
- A deposit held because its amount or currency did not match is now logged at **error** level, like the other held cases. It was a warning, so a store forwarding only error-level logs — as the README says to — never heard about money it was holding.
