import { ModuleProvider, Modules } from "@medusajs/framework/utils"
import AfriexPaymentProviderService from "./service"

export default ModuleProvider(Modules.PAYMENT, {
  services: [AfriexPaymentProviderService],
})

export { AfriexPaymentProviderService }
