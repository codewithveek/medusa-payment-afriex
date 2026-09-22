/**
 * Kept so existing imports of `providers/afriex-payment/service` keep working.
 * The bank-transfer provider now lives in `bank-transfer-service.ts`.
 *
 * @deprecated Import `AfriexBankTransferService` from the provider's index.
 */
export { default } from "./bank-transfer-service"
