import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import AfriexBankTransferService from "./bank-transfer-service"
import AfriexCheckoutService from "./checkout-service"

/**
 * Both Afriex payment methods, from one configuration block — the pattern
 * Medusa's own Stripe provider uses. They register as `pp_afriex_<id>` (bank
 * transfer) and `pp_afriex-checkout_<id>` (hosted checkout), and an admin
 * turns each on or off per region.
 */
export default ModuleProvider(Modules.PAYMENT, {
  services: [AfriexBankTransferService, AfriexCheckoutService],
})

export { AfriexBankTransferService, AfriexCheckoutService }

/** @deprecated Use `AfriexBankTransferService`. */
export { AfriexBankTransferService as AfriexPaymentProviderService }
