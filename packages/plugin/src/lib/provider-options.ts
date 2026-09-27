import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { MedusaContainer } from "@medusajs/framework/types"
import type { AfriexProviderOptions } from "./types"

/**
 * The Afriex provider's options, read from the app's own config. The providers
 * hold them, but they live in the payment module's container, out of reach of
 * the plugin's routes; the config module is where both come from.
 *
 * Undefined when the config cannot be read or has no Afriex provider, in which
 * case callers claim nothing about what the store has set.
 */
export function readProviderOptions(container: MedusaContainer): AfriexProviderOptions | undefined {
  try {
    const config = container.resolve<{ modules?: unknown }>(ContainerRegistrationKeys.CONFIG_MODULE)

    const modules = Array.isArray(config?.modules)
      ? config.modules
      : Object.values((config?.modules ?? {}) as Record<string, unknown>)

    for (const entry of modules as { options?: { providers?: unknown } }[]) {
      for (const provider of (entry?.options?.providers ?? []) as {
        resolve?: unknown
        options?: unknown
      }[]) {
        if (typeof provider?.resolve === "string" && provider.resolve.includes("afriex")) {
          return (
            provider.options && typeof provider.options === "object"
              ? provider.options
              : {}
          ) as AfriexProviderOptions
        }
      }
    }
  } catch {
    // Nothing claimed when the config cannot be read.
  }

  return undefined
}
