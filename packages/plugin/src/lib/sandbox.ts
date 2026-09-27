/**
 * Afriex's sandbox decides a checkout payment's outcome from the
 * `merchantReference` (docs.afriex.com → Integration Guide → "Testing
 * transaction outcomes in sandbox"): a reference containing `fail` settles as
 * FAILED, `SIMULATE_INSTANT` settles in about 30 seconds instead of 5–6
 * minutes, and `SIMULATE_OTP` / `SIMULATE_NO_OTP` decide whether a mobile-money
 * payment asks for a one-time password (`123456` in sandbox). Production
 * ignores all of them.
 *
 * The plugin's reference is the payment session id, which every webhook is
 * matched on. So the control words go after a separator the id never contains,
 * and are stripped again when a webhook comes back.
 */

/** What a test may ask for. Read from `data.sandbox` on the pay call, in staging only. */
export type SandboxRequest = {
  outcome?: "success" | "fail"
  /** Settle in about 30 seconds. */
  instant?: boolean
  /** Ask for a one-time password on the hosted page (`true`), or never (`false`). */
  otp?: boolean
}

const SEPARATOR = "--"

/** Reads a sandbox request from what a storefront sent; anything malformed is nothing. */
export function readSandboxRequest(value: unknown): SandboxRequest | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }
  const raw = value as Record<string, unknown>
  const request: SandboxRequest = {}
  if (raw.outcome === "success" || raw.outcome === "fail") {
    request.outcome = raw.outcome
  }
  if (typeof raw.instant === "boolean") {
    request.instant = raw.instant
  }
  if (typeof raw.otp === "boolean") {
    request.otp = raw.otp
  }
  return Object.keys(request).length ? request : undefined
}

/** Afriex's control words for a request, e.g. `SIMULATE_INSTANT_FAIL`; empty when nothing was asked. */
export function sandboxHint(request: SandboxRequest | undefined): string {
  if (!request) {
    return ""
  }
  const words: string[] = []
  if (request.instant) {
    words.push("SIMULATE_INSTANT")
  }
  if (request.otp === true) {
    words.push("SIMULATE_OTP")
  } else if (request.otp === false) {
    words.push("SIMULATE_NO_OTP")
  }
  if (request.outcome === "fail") {
    words.push("FAIL")
  }
  return words.join("_")
}

/** The reference to send Afriex: the session id, with the control words after it when there are any. */
export function withSandboxHint(sessionId: string, hint: string): string {
  return hint ? `${sessionId}${SEPARATOR}${hint}` : sessionId
}

/**
 * The session id a reference carries, with any control words removed. Medusa
 * ids are `prefix_` plus upper-case letters and digits, so the separator and
 * the words can only be the plugin's own.
 */
export function stripSandboxHint(reference: string): string {
  const at = reference.indexOf(SEPARATOR)
  if (at <= 0) {
    return reference
  }
  return /^[A-Z_]+$/.test(reference.slice(at + SEPARATOR.length)) ? reference.slice(0, at) : reference
}
