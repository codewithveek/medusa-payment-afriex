import { AfriexSDK } from "@afriex/sdk"
import type { AfriexProviderOptions } from "./types"

/**
 * One SDK instance per provider registration. `webhookPublicKey` must be passed
 * here and not added later — `afriex.webhooks` can only verify signatures when
 * the key was present at construction.
 */
export function createAfriexSdk(options: AfriexProviderOptions): AfriexSDK {
  return new AfriexSDK({
    apiKey: options.apiKey,
    environment: options.environment,
    webhookPublicKey: options.webhookPublicKey,
    retryConfig: {
      maxRetries: 3,
      retryDelay: 1000,
      retryableStatusCodes: [408, 429, 500, 502, 503, 504],
    },
  })
}
