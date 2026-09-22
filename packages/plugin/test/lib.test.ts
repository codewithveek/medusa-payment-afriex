import { describe, expect, it } from "vitest"
import {
  afriexCollectionLockKey,
  afriexMethodOf,
  isAfriexProviderId,
} from "../src/lib/constants"
import { mapAfriexStatus, mapAfriexStatusToMedusaStatus } from "../src/lib/map-status"
import { readSessionData } from "../src/lib/session-data"
import * as provider from "../src/providers/afriex-payment"
import AfriexBankTransferService from "../src/providers/afriex-payment/bank-transfer-service"
import LegacyServiceImport from "../src/providers/afriex-payment/service"

describe("provider ids", () => {
  it("tells the two Afriex methods apart, and everything else from them", () => {
    expect(afriexMethodOf("pp_afriex_afriex")).toBe("bank_transfer")
    expect(afriexMethodOf("pp_afriex-checkout_afriex")).toBe("checkout")
    expect(afriexMethodOf("pp_stripe_stripe")).toBeUndefined()
    expect(afriexMethodOf("pp_afriexish_x")).toBeUndefined()
    expect(afriexMethodOf(undefined)).toBeUndefined()

    expect(isAfriexProviderId("pp_afriex_other")).toBe(true)
    expect(isAfriexProviderId("pp_system_default")).toBe(false)
  })

  it("locks per payment collection", () => {
    expect(afriexCollectionLockKey("paycol_1")).toBe("afriex:payment-collection:paycol_1")
  })
})

describe("status mapping by method", () => {
  it("treats a checkout shopper approving a prompt as pending, not as needing review", () => {
    expect(mapAfriexStatus("CUSTOMER_ACTION_REQUIRED", "checkout")).toBe("pending")
    expect(mapAfriexStatus("CUSTOMER_ACTION_REQUIRED", "bank_transfer")).toBe("requires_more")
  })

  it("maps everything else the same way for both methods", () => {
    for (const status of [
      "PENDING",
      "SUCCESS",
      "FAILED",
      "CANCELLED",
      "IN_REVIEW",
      "AMOUNT_MISMATCH",
      "SETTLED_AFTER_CANCEL",
      "COLLECTION_AMOUNT_CHANGED",
      "SOMETHING_NEW",
    ]) {
      expect(mapAfriexStatus(status, "checkout")).toBe(mapAfriexStatusToMedusaStatus(status))
      expect(mapAfriexStatus(status, "bank_transfer")).toBe(
        mapAfriexStatusToMedusaStatus(status)
      )
    }
  })
})

describe("readSessionData", () => {
  it("takes the method from the provider id, not from the data", () => {
    const read = readSessionData("pp_afriex-checkout_afriex", { method: "bank_transfer" })
    expect(read?.method).toBe("checkout")
    expect(read?.data.method).toBe("checkout")
  })

  it("reads sessions stored before the method was recorded as bank transfer", () => {
    const read = readSessionData("pp_afriex_afriex", { collectionMethod: "dedicated" })
    expect(read?.method).toBe("bank_transfer")
  })

  it("is undefined for a session that is not Afriex's", () => {
    expect(readSessionData("pp_stripe_stripe", {})).toBeUndefined()
  })
})

describe("provider exports", () => {
  it("keeps the old names pointing at the bank-transfer provider", () => {
    expect(provider.AfriexBankTransferService).toBe(AfriexBankTransferService)
    expect(provider.AfriexPaymentProviderService).toBe(AfriexBankTransferService)
    expect(LegacyServiceImport).toBe(AfriexBankTransferService)
    expect(AfriexBankTransferService.identifier).toBe("afriex")
  })
})
