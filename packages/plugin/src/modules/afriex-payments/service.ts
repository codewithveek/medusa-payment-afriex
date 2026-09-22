import { MedusaService } from "@medusajs/framework/utils"
import { PaymentReference } from "./models/payment-reference"
import { Settlement } from "./models/settlement"

class AfriexPaymentsModuleService extends MedusaService({
  PaymentReference,
  Settlement,
}) {}

export default AfriexPaymentsModuleService
