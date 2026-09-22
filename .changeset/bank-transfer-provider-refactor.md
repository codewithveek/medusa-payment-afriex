---
"medusa-payment-afriex": patch
---

Split the payment provider into a shared base and a bank-transfer service, ready for a second Afriex payment method. The provider id stays `pp_afriex_afriex`; the old `AfriexPaymentProviderService` export and the `providers/afriex-payment/service` import path keep working.

- The bank-transfer provider now sets every session field it later trusts when it creates the session. Before, values a storefront sent in the session `data` (a status, a received amount, a refund line) survived Medusa's merge.
- A storefront can no longer choose which Afriex customer a new virtual account is minted for. Before, an `afriexCustomerId` in the session `data` sent at checkout was used as is.
