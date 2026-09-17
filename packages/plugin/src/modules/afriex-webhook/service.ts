import { MedusaService } from "@medusajs/framework/utils"
import { ProcessedWebhook } from "./models/processed-webhook"

class AfriexWebhookModuleService extends MedusaService({
  ProcessedWebhook,
}) {}

export default AfriexWebhookModuleService
