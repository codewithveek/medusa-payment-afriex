import { ExecArgs } from "@medusajs/framework/types"
import {
  ContainerRegistrationKeys,
  Modules,
  ProductStatus,
} from "@medusajs/framework/utils"
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createProductsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows"

/**
 * Seeds just enough store for a cart to reach the Afriex payment step: an NGN
 * region with both Afriex payment methods turned on, one product, and a
 * shipping option to pick.
 *
 * The id Medusa stores for each provider is `pp_<identifier>_<config id>`. The
 * identifiers come from the plugin; the config id from medusa-config.ts.
 */
const AFRIEX_BANK_TRANSFER = "pp_afriex_afriex"
const AFRIEX_CHECKOUT = "pp_afriex-checkout_afriex"
const COUNTRY = "ng"

export default async function seedAfriexExample({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const link = container.resolve(ContainerRegistrationKeys.LINK)
  const storeModuleService = container.resolve(Modules.STORE)
  const fulfillmentModuleService = container.resolve(Modules.FULFILLMENT)

  logger.info("Seeding sales channel...")
  const { result: salesChannels } = await createSalesChannelsWorkflow(
    container
  ).run({
    input: { salesChannelsData: [{ name: "Afriex Example Channel" }] },
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
          countries: [COUNTRY],
          payment_providers: [AFRIEX_BANK_TRANSFER, AFRIEX_CHECKOUT],
        },
      ],
    },
  })

  await createTaxRegionsWorkflow(container).run({
    input: [{ country_code: COUNTRY, provider_id: "tp_system" }],
  })

  logger.info("Seeding stock location...")
  const { result: stockLocations } = await createStockLocationsWorkflow(
    container
  ).run({
    input: {
      locations: [
        {
          name: "Lagos Warehouse",
          address: { city: "Lagos", country_code: "NG", address_1: "" },
        },
      ],
    },
  })
  const stockLocation = stockLocations[0]

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  })

  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: stockLocation.id, add: [salesChannel.id] },
  })

  logger.info("Seeding shipping option...")
  const { result: shippingProfiles } = await createShippingProfilesWorkflow(
    container
  ).run({
    input: { data: [{ name: "Default", type: "default" }] },
  })
  const shippingProfile = shippingProfiles[0]

  // There is no createFulfillmentSetsWorkflow — the module service is the
  // documented way in, and it creates the nested service zone in one call.
  const fulfillmentSet = await fulfillmentModuleService.createFulfillmentSets({
    name: "Nigeria delivery",
    type: "shipping",
    service_zones: [
      {
        name: "Nigeria",
        geo_zones: [{ country_code: COUNTRY, type: "country" }],
      },
    ],
  })

  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: stockLocation.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: fulfillmentSet.id },
  })

  await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Standard delivery",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: fulfillmentSet.service_zones[0].id,
        shipping_profile_id: shippingProfile.id,
        type: {
          label: "Standard",
          description: "Arrives in 3-5 business days.",
          code: "standard",
        },
        prices: [{ currency_code: "ngn", amount: 2500 }],
        rules: [
          {
            attribute: "enabled_in_store",
            value: "true",
            operator: "eq",
          },
          {
            attribute: "is_return",
            value: "false",
            operator: "eq",
          },
        ],
      },
    ],
  })

  logger.info("Seeding product...")
  const { result: products } = await createProductsWorkflow(container).run({
    input: {
      products: [
        {
          title: "Afriex Test Hoodie",
          description:
            "A single seeded product, here so a cart can reach the Afriex payment step.",
          handle: "afriex-test-hoodie",
          status: ProductStatus.PUBLISHED,
          shipping_profile_id: shippingProfile.id,
          sales_channels: [{ id: salesChannel.id }],
          options: [{ title: "Size", values: ["M", "L"] }],
          variants: [
            {
              title: "M",
              sku: "AFRIEX-HOODIE-M",
              options: { Size: "M" },
              manage_inventory: true,
              prices: [{ currency_code: "ngn", amount: 24500 }],
            },
            {
              title: "L",
              sku: "AFRIEX-HOODIE-L",
              options: { Size: "L" },
              manage_inventory: true,
              prices: [{ currency_code: "ngn", amount: 24500 }],
            },
          ],
        },
      ],
    },
  })

  const inventoryModuleService = container.resolve(Modules.INVENTORY)
  const inventoryItems = await inventoryModuleService.listInventoryItems({
    sku: products[0].variants.map((v) => v.sku!),
  })

  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: inventoryItems.map((item) => ({
        inventory_item_id: item.id,
        location_id: stockLocation.id,
        stocked_quantity: 100,
      })),
    },
  })

  logger.info("Seeding publishable API key...")
  const { result: apiKeys } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [{ title: "Afriex Example", type: "publishable", created_by: "" }],
    },
  })
  const publishableKey = apiKeys[0]

  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: publishableKey.id, add: [salesChannel.id] },
  })

  logger.info("")
  logger.info("Done. Put this in examples/storefront/.env:")
  logger.info(`  MEDUSA_PUBLISHABLE_KEY=${publishableKey.token}`)
}
