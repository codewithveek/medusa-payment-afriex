import { describe, expect, it } from "vitest"
import {
  readSandboxRequest,
  sandboxHint,
  stripSandboxHint,
  withSandboxHint,
} from "../src/lib/sandbox"
import { getSessionId, readCheckoutSessionEvent } from "../src/lib/webhook-mapping"
import { buildCheckoutSessionPayload, buildTransactionPayload, SESSION_ID } from "./mocks/afriex.mock"

describe("choosing a sandbox outcome through the reference", () => {
  it("turns a request into Afriex's control words", () => {
    expect(sandboxHint(undefined)).toBe("")
    expect(sandboxHint({ outcome: "success" })).toBe("")
    expect(sandboxHint({ outcome: "fail" })).toBe("FAIL")
    expect(sandboxHint({ instant: true })).toBe("SIMULATE_INSTANT")
    expect(sandboxHint({ instant: true, outcome: "fail" })).toBe("SIMULATE_INSTANT_FAIL")
    expect(sandboxHint({ otp: true })).toBe("SIMULATE_OTP")
    expect(sandboxHint({ otp: false, instant: true })).toBe("SIMULATE_INSTANT_SIMULATE_NO_OTP")
  })

  it("reads only what a storefront may ask for", () => {
    expect(readSandboxRequest(undefined)).toBeUndefined()
    expect(readSandboxRequest("fail")).toBeUndefined()
    expect(readSandboxRequest({ outcome: "explode" })).toBeUndefined()
    expect(readSandboxRequest({ outcome: "fail", instant: "yes", otp: true })).toEqual({
      outcome: "fail",
      otp: true,
    })
  })

  it("puts the words after the session id and takes them off again", () => {
    const sent = withSandboxHint(SESSION_ID, "SIMULATE_INSTANT_FAIL")
    expect(sent).toBe(`${SESSION_ID}--SIMULATE_INSTANT_FAIL`)
    expect(stripSandboxHint(sent)).toBe(SESSION_ID)

    expect(withSandboxHint(SESSION_ID, "")).toBe(SESSION_ID)
    expect(stripSandboxHint(SESSION_ID)).toBe(SESSION_ID)
    // Only the plugin's own words come off; anything else is someone else's reference.
    expect(stripSandboxHint("order--123")).toBe("order--123")
    expect(stripSandboxHint("--FAIL")).toBe("--FAIL")
  })

  it("is invisible to webhook matching", () => {
    const transaction = buildTransactionPayload({
      merchantReference: `${SESSION_ID}--SIMULATE_INSTANT_FAIL`,
      meta: { reference: `${SESSION_ID}--SIMULATE_INSTANT_FAIL` },
    })
    expect(getSessionId(transaction.data)).toBe(SESSION_ID)

    const older = buildTransactionPayload({ merchantReference: undefined, meta: { reference: `${SESSION_ID}--FAIL` } })
    expect(getSessionId(older.data)).toBe(SESSION_ID)

    const link = buildCheckoutSessionPayload({ merchantReference: `${SESSION_ID}--SIMULATE_OTP` })
    expect(readCheckoutSessionEvent(link.data).merchantReference).toBe(SESSION_ID)
  })
})
