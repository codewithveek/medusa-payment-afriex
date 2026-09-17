import { Module } from "@medusajs/framework/utils"
import AfriexWebhookModuleService from "./service"

export const AFRIEX_WEBHOOK_MODULE = "afriex_webhook"

export default Module(AFRIEX_WEBHOOK_MODULE, {
  service: AfriexWebhookModuleService,
})

export { AfriexWebhookModuleService }
