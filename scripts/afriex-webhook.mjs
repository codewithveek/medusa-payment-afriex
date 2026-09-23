#!/usr/bin/env node
// @ts-check
/**
 * Afriex webhook simulator — for LOCAL testing only.
 *
 * Afriex signs every webhook with its private key, and the plugin only trusts
 * what verifies against the public key in its config. You cannot forge Afriex's
 * signature, so to exercise the webhook path without moving real money you swap
 * the roles: generate your own key pair, give the plugin *your* public key, and
 * sign test events with your private key. The plugin cannot tell the
 * difference, which is exactly why this key must never reach a real server.
 *
 *   node scripts/afriex-webhook.mjs keygen
 *   node scripts/afriex-webhook.mjs send --session payses_... --amount 25000
 *   node scripts/afriex-webhook.mjs help
 *
 * No dependencies. Needs Node >= 20.
 */
import { createSign, generateKeyPairSync, randomBytes } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const KEY_DIR = join(ROOT, ".afriex-dev")
const PRIVATE_KEY_PATH = join(KEY_DIR, "webhook-private.pem")
const PUBLIC_KEY_PATH = join(KEY_DIR, "webhook-public.pem")

const SIGNATURE_HEADER = "x-webhook-signature"
const DEFAULT_URL = "http://localhost:9000/afriex/webhook"

const STATUSES = [
  "PENDING", "PROCESSING", "SUCCESS", "FAILED", "CANCELLED", "REFUNDED", "RETRY",
  "UNKNOWN", "SCHEDULED", "CUSTOMER_ACTION_REQUIRED", "REJECTED", "IN_REVIEW",
  "DISPUTED", "DISPUTE_RESOLVED", "DISPUTE_WON", "DISPUTE_LOST",
  "DISPUTE_EVIDENCE_SUBMITTED",
]

/** What each handler outcome means, so the output explains itself. */
const OUTCOMES = {
  captured: "The deposit matched. The session was authorized and captured, and the cart is now an order (or the existing order is now paid).",
  amount_mismatch: "The deposit settled but the amount or currency did not match the session. Nothing was captured; the session is at requires_more and the admin widget shows expected vs received.",
  extra_deposit: "The session was already paid by another transaction. This one was recorded as an extra deposit to refund — see the admin widget.",
  status_recorded: "A non-settled status. It was written onto the session (or left alone if the session had already settled). Nothing was captured.",
  settled_after_cancel: "The deposit settled on an order that was cancelled. Nothing was captured; the admin widget says it needs a refund.",
  collection_amount_changed: "The deposit matched the total the shopper was shown, but an admin changed the order total since. Nothing was captured; it is held for review.",
  held: "The session this reference belonged to no longer exists, but the plugin's ledger knew the reference. The payment is held against its order — apply it or refund it from the admin API.",
  duplicate: "This exact event was already processed. Nothing happened — that is idempotency working.",
  unknown_session: "The signature verified, but no payment session matched the reference (or the account id). Nothing was changed.",
  ignored: "Not an event the plugin acts on, or one carrying nothing it can use. Acknowledged and ignored.",
  late_payment_attributed:
    "The deposit arrived for a reference whose session was gone, and the order had exactly one unpaid Afriex session for the same amount. It was applied there and captured — no one had to step in.",
  checkout_session_recorded:
    "Afriex reported the payment link. Its real expiry and Afriex's session id were written onto the payment session and the ledger. No money moved.",
}

const HELP = `
Afriex webhook simulator — local testing only

  keygen                Generate a throwaway RSA key pair in .afriex-dev/ and
                        print the line to put in your Medusa .env.

  send [options]        Sign a TRANSACTION event and POST it to the plugin.

    --session <id>      Payment session id to use as the reference (payses_...).
                        Required unless --no-reference is given.
    --amount <n>        Amount received, in major units (25000 = NGN 25,000).
    --currency <code>   Currency received.               Default: NGN
    --status <status>   Afriex transaction status.        Default: SUCCESS
    --event <name>      TRANSACTION.UPDATED | TRANSACTION.CREATED |
                        CHECKOUT_SESSION.CREATED          Default: TRANSACTION.UPDATED
    --transaction <id>  Transaction id. Reuse one to simulate later updates to
                        the same transfer.                Default: random
    --account <id>      The Afriex payment method id of the virtual account
                        (session data: afriexPaymentMethodId). Sent as sourceId.
    --channel <name>    VIRTUAL_BANK_ACCOUNT | MOBILE_MONEY | CARD
                                                          Default: VIRTUAL_BANK_ACCOUNT
    --failure-code <c>  With --status FAILED or REJECTED: meta.failureReason.code
    --failure-message <m>  ...and its customer-safe message.
    --retryable         ...and mark the failure retryable.
    --otp-required      Set meta.otpRequired (hosted mobile money waiting on a code).
    --fee <n>           Fee Afriex reports, in the source currency.
    --reference <r>     Top-level merchantReference, when it should differ from --session.
    --meta-reference <r>  meta.reference, when it should differ from --session.
    --no-reference      Omit the reference, to test matching by --account alone.
    --url <url>         Webhook endpoint.  Default: ${DEFAULT_URL}
    --repeat <n>        Send the identical event n times (idempotency check).
    --bad-signature     Tamper with the body after signing. Expect a 401.
    --dry-run           Print the payload and signature; send nothing.

  With --event CHECKOUT_SESSION.CREATED (how Afriex reports a payment link):
    --afriex-session <id>  Afriex's own session id.        Default: random uuid
    --expires-in <min>     Minutes until the link expires. Default: 15
    --paid-at <iso>        Simulate the re-send Afriex makes once the link is
                           paid. Recorded, never treated as payment.

Recipes
  Pay an order                 send --session payses_X --amount 25000
  Underpay it                  send --session payses_X --amount 20000
  Wrong currency               send --session payses_X --amount 25000 --currency GHS
  Redelivery is harmless       send --session payses_X --amount 25000 --transaction txn_1 --repeat 3
  Shopper pays twice           (pay it once, then) send --session payses_X --amount 25000
  In review, then settles      send --session payses_X --amount 25000 --transaction txn_1 --status IN_REVIEW
                               send --session payses_X --amount 25000 --transaction txn_1
  Forged request               send --session payses_X --amount 25000 --bad-signature
  Reference lost in transit    send --no-reference --account <paymentMethodId> --amount 25000

Afriex Checkout (the session is the pay-stage session, payses_...)
  Paid by mobile money         send --session payses_X --amount 25000 --channel MOBILE_MONEY
  Waiting on the phone prompt  send --session payses_X --amount 25000 --channel MOBILE_MONEY --status CUSTOMER_ACTION_REQUIRED --otp-required
  Card declined, then paid     send --session payses_X --amount 25000 --channel CARD --status FAILED --failure-code AFX_CARD_DECLINED --failure-message "Your card was declined."
                               send --session payses_X --amount 25000 --channel MOBILE_MONEY
  Paid on a replaced link      send --session payses_OLD --amount 25000   (held against its order)
`

function fail(message) {
  console.error(`\n  ${message}\n`)
  process.exit(1)
}

/** Minimal flag parser: `--key value` and bare `--flag`. */
function parseFlags(argv) {
  /** @type {Record<string, string | boolean>} */
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith("--")) {
      fail(`Unexpected argument "${token}". Run with "help" to see the options.`)
    }
    const key = token.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true
    } else {
      flags[key] = next
      i++
    }
  }
  return flags
}

function keygen() {
  if (existsSync(PRIVATE_KEY_PATH)) {
    console.log(`\n  A key pair already exists in ${KEY_DIR} — reusing it.`)
  } else {
    // RSA, because that is what Afriex signs with (RSA-SHA256, base64).
    const { privateKey, publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    })
    mkdirSync(KEY_DIR, { recursive: true })
    writeFileSync(PRIVATE_KEY_PATH, privateKey, { mode: 0o600 })
    writeFileSync(PUBLIC_KEY_PATH, publicKey)
    console.log(`\n  Generated a test key pair in ${KEY_DIR} (git-ignored).`)
  }

  const publicKey = readFileSync(PUBLIC_KEY_PATH, "utf8").trim()
  const envLine = `AFRIEX_WEBHOOK_PUBLIC_KEY="${publicKey.replace(/\r?\n/g, "\\n")}"`

  console.log(`
  1. Put this line in your Medusa .env, replacing the real Afriex key:

${envLine}

  2. Restart Medusa. The provider reads its options once, at boot.

  3. Send events with:  node scripts/afriex-webhook.mjs send --session <id> --amount <n>

  !! LOCAL USE ONLY. Anyone holding .afriex-dev/webhook-private.pem can mark
  !! orders as paid on any server configured with this public key. Never deploy
  !! it. Put Afriex's real key back before you go anywhere near production.
`)
}

async function send(flags) {
  if (!existsSync(PRIVATE_KEY_PATH)) {
    fail(`No test key found. Run "node scripts/afriex-webhook.mjs keygen" first.`)
  }

  const noReference = flags["no-reference"] === true
  const session = typeof flags.session === "string" ? flags.session : undefined
  const account = typeof flags.account === "string" ? flags.account : undefined
  const status = String(flags.status ?? "SUCCESS").toUpperCase()
  const event = String(flags.event ?? "TRANSACTION.UPDATED").toUpperCase()
  const currency = String(flags.currency ?? "NGN").toUpperCase()
  const url = String(flags.url ?? DEFAULT_URL)
  const repeat = Math.max(1, Number.parseInt(String(flags.repeat ?? "1"), 10) || 1)
  const channel = String(flags.channel ?? "VIRTUAL_BANK_ACCOUNT").toUpperCase()
  const merchantReference = typeof flags.reference === "string" ? flags.reference : session
  const metaReference = typeof flags["meta-reference"] === "string" ? flags["meta-reference"] : session

  const checkoutSessionEvent = event === "CHECKOUT_SESSION.CREATED"

  if (!noReference && !session) {
    fail(`--session <id> is required (or pass --no-reference with --account).`)
  }
  if (noReference && !account) {
    fail(`--no-reference needs --account <paymentMethodId>, or nothing could match.`)
  }
  if (!checkoutSessionEvent && (typeof flags.amount !== "string" || !Number.isFinite(Number(flags.amount)))) {
    fail(`--amount <n> is required and must be a number, in major units.`)
  }
  if (!checkoutSessionEvent && !STATUSES.includes(status)) {
    fail(`Unknown --status "${status}". One of: ${STATUSES.join(", ")}`)
  }
  if (!["TRANSACTION.UPDATED", "TRANSACTION.CREATED", "CHECKOUT_SESSION.CREATED"].includes(event)) {
    fail(`--event must be TRANSACTION.UPDATED, TRANSACTION.CREATED or CHECKOUT_SESSION.CREATED.`)
  }
  if (!["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY", "CARD"].includes(channel)) {
    fail(`--channel must be VIRTUAL_BANK_ACCOUNT, MOBILE_MONEY or CARD.`)
  }
  if (flags.fee !== undefined && !Number.isFinite(Number(flags.fee))) {
    fail(`--fee must be a number.`)
  }

  const failed = status === "FAILED" || status === "REJECTED"
  const failureReason =
    failed && (typeof flags["failure-code"] === "string" || typeof flags["failure-message"] === "string")
      ? {
          code: typeof flags["failure-code"] === "string" ? flags["failure-code"] : "AFX_SIMULATED",
          message: typeof flags["failure-message"] === "string" ? flags["failure-message"] : "Simulated failure.",
          retryable: flags.retryable === true,
        }
      : undefined

  const amount = Number(flags.amount).toFixed(2)
  const now = new Date().toISOString()
  const transactionId =
    typeof flags.transaction === "string"
      ? flags.transaction
      : `txn_sim_${randomBytes(6).toString("hex")}`

  // The shape Afriex delivers for a hosted checkout session. It reports the
  // link, never a payment: the money arrives as a TRANSACTION.* event.
  const expiresInMinutes = Number(flags["expires-in"] ?? 15)
  const afriexSessionId =
    typeof flags["afriex-session"] === "string"
      ? flags["afriex-session"]
      : `${randomBytes(4).toString("hex")}-${randomBytes(2).toString("hex")}-4${randomBytes(2).toString("hex").slice(1)}-${randomBytes(2).toString("hex")}-${randomBytes(6).toString("hex")}`

  const checkoutSessionPayload = {
    event,
    data: {
      sessionId: afriexSessionId,
      merchantReference,
      amount: Math.round(Number(flags.amount ?? 0) * 100),
      currency,
      expiresAt: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
      createdAt: now,
      metadata: {},
      customer: {
        name: "Simulated Shopper",
        email: "shopper@example.com",
        phone: "+2348012345678",
        countryCode: "NG",
      },
      ...(typeof flags["paid-at"] === "string" ? { paidAt: flags["paid-at"] } : {}),
    },
  }

  // The same shape Afriex delivers (TransactionWebhookPayload in @afriex/sdk).
  const transactionPayload = {
    event,
    data: {
      status,
      type: "DEPOSIT",
      channel,
      sourceAmount: amount,
      sourceCurrency: currency,
      destinationAmount: amount,
      destinationCurrency: currency,
      ...(account ? { sourceId: account } : {}),
      ...(flags.fee !== undefined ? { fee: Number(flags.fee).toFixed(2) } : {}),
      customerId: "cus_simulated",
      transactionId,
      ...(noReference ? {} : { merchantReference }),
      meta: {
        ...(noReference ? {} : { reference: metaReference }),
        ...(failureReason ? { failureReason } : {}),
        ...(flags["otp-required"] === true ? { otpRequired: true } : {}),
      },
      createdAt: now,
      updatedAt: now,
    },
  }

  const payload = checkoutSessionEvent ? checkoutSessionPayload : transactionPayload

  // The signature covers the exact bytes sent, so the body is serialized once
  // and that one string is both signed and posted.
  const body = JSON.stringify(payload)
  const signature = createSign("SHA256")
    .update(body)
    .sign(readFileSync(PRIVATE_KEY_PATH, "utf8"), "base64")

  const sentBody = flags["bad-signature"] === true ? body.replace(amount, "1.00") : body

  if (flags["dry-run"] === true) {
    console.log(`\nPOST ${url}\n${SIGNATURE_HEADER}: ${signature}\n\n${JSON.stringify(payload, null, 2)}\n`)
    return
  }

  console.log(`\n  ${event}  ${status}  ${amount} ${currency}  →  ${url}`)
  console.log(`  transaction ${transactionId}${session && !noReference ? `  ·  session ${session}` : ""}${account ? `  ·  account ${account}` : ""}`)

  for (let attempt = 1; attempt <= repeat; attempt++) {
    let response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", [SIGNATURE_HEADER]: signature },
        body: sentBody,
      })
    } catch (error) {
      fail(`Could not reach ${url} — is Medusa running? (${/** @type {Error} */ (error).message})`)
    }

    const text = await response.text()
    /** @type {{ outcome?: string, error?: string } | undefined} */
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }

    const label = repeat > 1 ? `  #${attempt}  ` : "  "
    console.log(`\n${label}HTTP ${response.status}  ${text}`)
    console.log(`${label}${explain(response.status, json)}`)
  }
  console.log("")
}

/** @param {number} status @param {{ outcome?: string, error?: string } | undefined} json */
function explain(status, json) {
  if (status === 401) {
    return "Signature rejected. Expected with --bad-signature. Otherwise the server is not using the key from `keygen` — check AFRIEX_WEBHOOK_PUBLIC_KEY and restart Medusa."
  }
  if (status === 404) {
    return "No such route. The plugin must be listed under `plugins` in medusa-config.ts (not only as a payment provider), and must be built."
  }
  if (status === 503) {
    return "Not ready: either an earlier delivery of this same event is still being processed, or the event arrived before the thing it describes was saved (a CHECKOUT_SESSION.CREATED beating its own payment link). The claim was handed back, so Afriex's retry is processed properly."
  }
  if (status === 500) {
    return "The handler failed and released its claim, so a retry would be processed again. The Medusa log has the reason at error level."
  }
  if (status === 400) {
    return `Rejected before verification: ${json?.error ?? "bad request"}.`
  }
  const outcome = json?.outcome
  return (outcome && OUTCOMES[/** @type {keyof typeof OUTCOMES} */ (outcome)]) || "Done."
}

const [command, ...rest] = process.argv.slice(2)

switch (command) {
  case "keygen":
    keygen()
    break
  case "send":
    await send(parseFlags(rest))
    break
  case undefined:
  case "help":
  case "--help":
  case "-h":
    console.log(HELP)
    break
  default:
    fail(`Unknown command "${command}". Try: keygen | send | help`)
}
