import { Module } from "@medusajs/framework/utils"
import AfriexPaymentsModuleService from "./service"

export const AFRIEX_PAYMENTS_MODULE = "afriex_payments"

export default Module(AFRIEX_PAYMENTS_MODULE, {
  service: AfriexPaymentsModuleService,
})

export { AfriexPaymentsModuleService }
