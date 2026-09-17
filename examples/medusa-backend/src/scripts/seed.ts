import { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Seeds the minimum a store needs before the Afriex provider can be exercised:
 * an NGN region that lists the provider, a sales channel and a publishable key
 * for the storefront to authenticate with.
 *
 * It deliberately does not seed a catalogue — run the stock Medusa starter seed
 * if you want products and shipping options as well.
 */
export default async function seedAfriexExample({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const storeModuleService = container.resolve(Modules.STORE)

  // The id Medusa stores is `pp_<provider identifier>_<config id>`, and both
  // halves come from medusa-config.ts.
  const AFRIEX_PROVIDER_ID = "pp_afriex_afriex"

  logger.info("Seeding sales channel...")
  const { result: salesChannels } = await createSalesChannelsWorkflow(
    container
  ).run({
    input: {
      salesChannelsData: [{ name: "Afriex Example Channel" }],
    },
  })
  const salesChannel = salesChannels[0]

  logger.info("Seeding store currencies...")
  const [store] = await storeModuleService.listStores()
  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        supported_currencies: [
          { currency_code: "ngn", is_default: true },
          { currency_code: "usd" },
        ],
        default_sales_channel_id: salesChannel.id,
      },
    },
  })

  logger.info("Seeding region with the Afriex payment provider...")
  await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "Nigeria",
          currency_code: "ngn",
          countries: ["ng"],
          payment_providers: [AFRIEX_PROVIDER_ID],
        },
      ],
    },
  })

  logger.info("Seeding publishable API key...")
  const { result: apiKeys } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [
        {
          title: "Afriex Example",
          type: "publishable",
          created_by: "",
        },
      ],
    },
  })
  const publishableKey = apiKeys[0]

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: {
      id: publishableKey.id,
      add: [salesChannel.id],
    },
  })

  logger.info(`Done. Publishable key: ${publishableKey.token}`)
}
