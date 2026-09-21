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
  duplicate: "This exact event was already processed. Nothing happened — that is idempotency working.",
  unknown_session: "The signature verified, but no payment session matched the reference (or the account id). Nothing was changed.",
  ignored: "Not a transaction event. Acknowledged and ignored.",
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
    --event <name>      TRANSACTION.UPDATED | TRANSACTION.CREATED
                                                          Default: TRANSACTION.UPDATED
    --transaction <id>  Transaction id. Reuse one to simulate later updates to
                        the same transfer.                Default: random
    --account <id>      The Afriex payment method id of the virtual account
                        (session data: afriexPaymentMethodId). Sent as sourceId.
    --no-reference      Omit the reference, to test matching by --account alone.
    --url <url>         Webhook endpoint.  Default: ${DEFAULT_URL}
    --repeat <n>        Send the identical event n times (idempotency check).
    --bad-signature     Tamper with the body after signing. Expect a 401.
    --dry-run           Print the payload and signature; send nothing.

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

  if (!noReference && !session) {
    fail(`--session <id> is required (or pass --no-reference with --account).`)
  }
  if (noReference && !account) {
    fail(`--no-reference needs --account <paymentMethodId>, or nothing could match.`)
  }
  if (typeof flags.amount !== "string" || !Number.isFinite(Number(flags.amount))) {
    fail(`--amount <n> is required and must be a number, in major units.`)
  }
  if (!STATUSES.includes(status)) {
    fail(`Unknown --status "${status}". One of: ${STATUSES.join(", ")}`)
  }
  if (event !== "TRANSACTION.UPDATED" && event !== "TRANSACTION.CREATED") {
    fail(`--event must be TRANSACTION.UPDATED or TRANSACTION.CREATED.`)
  }

  const amount = Number(flags.amount).toFixed(2)
  const now = new Date().toISOString()
  const transactionId =
    typeof flags.transaction === "string"
      ? flags.transaction
      : `txn_sim_${randomBytes(6).toString("hex")}`

  // The same shape Afriex delivers (TransactionWebhookPayload in @afriex/sdk).
  const payload = {
    event,
    data: {
      status,
      type: "DEPOSIT",
      channel: "VIRTUAL_BANK_ACCOUNT",
      sourceAmount: amount,
      sourceCurrency: currency,
      destinationAmount: amount,
      destinationCurrency: currency,
      ...(account ? { sourceId: account } : {}),
      customerId: "cus_simulated",
      transactionId,
      ...(noReference ? {} : { merchantReference: session }),
      meta: noReference ? {} : { reference: session },
      createdAt: now,
      updatedAt: now,
    },
  }

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
