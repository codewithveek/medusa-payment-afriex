import { AfriexSDK } from "@afriex/sdk"
import type { AfriexProviderOptions } from "./types"

/**
 * A PEM key is multi-line, and environment variables are where multi-line
 * values go to die. Depending on how it was stored, the key arrives with real
 * newlines, with literal `\n` sequences (most hosting dashboards, and any
 * unquoted `.env` value), or wrapped in stray quotes. All of those are the same
 * key, so they are made the same string before anything tries to parse it.
 */
export function normalizePublicKey(key: string): string {
  return key
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\r/g, "")
    .replace(/\\n/g, "\n")
    .trim()
}

/**
 * One SDK instance per provider registration. `webhookPublicKey` must be passed
 * here and not added later — `afriex.webhooks` can only verify signatures when
 * the key was present at construction.
 */
export function createAfriexSdk(options: AfriexProviderOptions): AfriexSDK {
  return new AfriexSDK({
    apiKey: options.apiKey,
    environment: options.environment,
    webhookPublicKey: normalizePublicKey(options.webhookPublicKey),
    retryConfig: {
      maxRetries: 3,
      retryDelay: 1000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    },
  })
}
