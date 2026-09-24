import { updateRegionsWorkflow } from "@medusajs/medusa/core-flows"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import type { IPaymentModuleService, MedusaContainer } from "@medusajs/framework/types"
import { AfriexAdminError } from "./admin-error"
import { AFRIEX_METHODS, afriexMethodOf, type AfriexMethod } from "./constants"
import { getAfriexOverview, type AfriexOverview } from "./overview"
import type { GraphQuery } from "./reconciliation"
import { readAfriexSettings, writeAfriexSettings } from "./settings"

type RegionRow = { id: string; payment_providers?: { id: string }[] }

/**
 * Turns one Afriex method off in every region, or back on.
 *
 * Off remembers which regions had it, so on restores exactly those rather than
 * switching it on everywhere — a store that deliberately never offered it in
 * one region keeps that decision. Every other payment provider on a region is
 * left alone.
 *
 * Money already on its way is unaffected: turning a method off only stops new
 * payments.
 */
export async function setMethodEverywhere(
  container: MedusaContainer,
  input: { method: string; enabled: boolean; confirmEmpty?: boolean }
): Promise<AfriexOverview & { changed_regions: string[] }> {
  if (!AFRIEX_METHODS.includes(input.method as AfriexMethod)) {
    throw new AfriexAdminError(
      "AFRIEX_NOT_AN_AFRIEX_PROVIDER",
      400,
      `\`${input.method}\` is not an Afriex payment method. Use ${AFRIEX_METHODS.join(" or ")}.`
    )
  }

  const method = input.method as AfriexMethod
  const paymentModule = container.resolve<IPaymentModuleService>(Modules.PAYMENT)
  const providers = await paymentModule.listPaymentProviders({}, { select: ["id"] })
  const providerId = providers.map((p) => p.id).find((id) => afriexMethodOf(id) === method)

  if (!providerId) {
    throw new AfriexAdminError(
      "AFRIEX_PROVIDER_NOT_REGISTERED",
      404,
      `No ${method} provider is registered. Check the provider in medusa-config.ts.`
    )
  }

  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY)
  const regions = (
    await query.graph({ entity: "region", fields: ["id", "payment_providers.id"] })
  ).data as RegionRow[]

  const settings = await readAfriexSettings(container)
  const remembered = settings.pausedRegions ?? {}

  const targets = input.enabled
    ? regions.filter(
        (region) =>
          (remembered[method] ?? []).includes(region.id) && !has(region, providerId)
      )
    : regions.filter((region) => has(region, providerId))

  if (!input.enabled && !input.confirmEmpty) {
    const emptied = targets.filter((region) => providersOf(region).length === 1)
    if (emptied.length) {
      throw new AfriexAdminError(
        "AFRIEX_REGION_WOULD_HAVE_NO_PROVIDERS",
        409,
        `${emptied.length === 1 ? "One region" : `${emptied.length} regions`} would be left with no payment method at all. Confirm to do it anyway.`,
        { regions: emptied.map((region) => region.id) }
      )
    }
  }

  for (const region of targets) {
    const next = input.enabled
      ? [...new Set([...providersOf(region), providerId])]
      : providersOf(region).filter((id) => id !== providerId)

    await updateRegionsWorkflow(container).run({
      input: { selector: { id: region.id }, update: { payment_providers: next } },
    })
  }

  // Remember what to restore, or forget it once restored.
  const nextRemembered = { ...remembered }
  if (input.enabled) {
    delete nextRemembered[method]
  } else if (targets.length) {
    nextRemembered[method] = targets.map((region) => region.id)
  }

  await writeAfriexSettings(container, {
    paused_regions: Object.keys(nextRemembered).length ? nextRemembered : null,
  })

  return {
    ...(await getAfriexOverview(container)),
    changed_regions: targets.map((region) => region.id),
  }
}

const providersOf = (region: RegionRow): string[] =>
  (region.payment_providers ?? []).map((provider) => provider.id)

const has = (region: RegionRow, providerId: string): boolean =>
  providersOf(region).includes(providerId)
