import { MedusaService } from "@medusajs/framework/utils"
import { PaymentReference } from "./models/payment-reference"
import { Setting } from "./models/setting"
import { Settlement } from "./models/settlement"

class AfriexPaymentsModuleService extends MedusaService({
  PaymentReference,
  Setting,
  Settlement,
}) {}

export default AfriexPaymentsModuleService
