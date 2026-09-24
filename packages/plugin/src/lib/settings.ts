import type { MedusaContainer } from "@medusajs/framework/types"
import { AFRIEX_PAYMENTS_MODULE } from "../modules/afriex-payments"
import type AfriexPaymentsModuleService from "../modules/afriex-payments/service"
import { AfriexAdminError } from "./admin-error"
import { CHECKOUT_CHANNELS, isCheckoutChannel } from "./checkout-channels"
import { AFRIEX_METHODS, type AfriexMethod } from "./constants"
import { isUniqueViolation } from "./db-errors"
import type { AfriexCheckoutChannel } from "./types"

/** The one row's key. Everything reads and writes that row. */
const SINGLETON = "afriex"

export type AfriexSettings = {
  /** The channels an admin allows, or null for "whatever the config allows". */
  checkoutChannels: AfriexCheckoutChannel[] | null
  /** Hide checkout's bank option where the store's own bank transfer is on. */
  hideBankChannelWhereBankTransfer: boolean
  /**
   * Where a method was turned off everywhere: the regions it was on at the
   * time, per method, so turning it back on restores exactly those and not
   * every region in the store.
   */
  pausedRegions: Partial<Record<AfriexMethod, string[]>> | null
}

const DEFAULTS: AfriexSettings = {
  checkoutChannels: null,
  hideBankChannelWhereBankTransfer: false,
  pausedRegions: null,
}

type SettingRow = {
  id: string
  checkout_channels: unknown
  hide_bank_channel_where_bank_transfer: boolean
  paused_regions: unknown
}

function store(container: MedusaContainer): AfriexPaymentsModuleService {
  return container.resolve(AFRIEX_PAYMENTS_MODULE)
}

/**
 * `{ checkout: ["reg_01"] }` — which regions a method was on when it was turned
 * off everywhere. Returns null for anything that is not that shape, which is
 * how the write path refuses it and the read path falls back.
 */
function pausedRegions(value: unknown): Partial<Record<AfriexMethod, string[]>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null
  }

  const entries = Object.entries(value as Record<string, unknown>).filter(
    ([method, regions]) =>
      AFRIEX_METHODS.includes(method as AfriexMethod) &&
      Array.isArray(regions) &&
      regions.every((id) => typeof id === "string")
  ) as [AfriexMethod, string[]][]

  return entries.length === Object.keys(value).length
    ? Object.fromEntries(entries.map(([method, regions]) => [method, [...new Set(regions)]]))
    : null
}

function channelList(value: unknown): AfriexCheckoutChannel[] | null {
  return Array.isArray(value) && value.every(isCheckoutChannel) && value.length
    ? (value as AfriexCheckoutChannel[])
    : null
}

/**
 * The store's Afriex settings. A store that has never saved any gets the
 * defaults, and so does one whose row cannot be read — these decide what a
 * shopper is offered, and failing to read them must not stop a payment.
 */
export async function readAfriexSettings(
  container: MedusaContainer
): Promise<AfriexSettings> {
  let row: SettingRow | undefined
  try {
    ;[row] = (await store(container).listSettings({ key: SINGLETON }, { take: 1 })) as
      | SettingRow[]
      | undefined[]
  } catch {
    // A store that has not run the migration yet, or a database hiccup. These
    // settings only narrow what is offered, so the defaults are the safe answer.
    return DEFAULTS
  }

  if (!row) {
    return DEFAULTS
  }

  return {
    checkoutChannels: channelList(row.checkout_channels),
    hideBankChannelWhereBankTransfer: row.hide_bank_channel_where_bank_transfer === true,
    pausedRegions: pausedRegions(row.paused_regions),
  }
}

export type SettingsPatch = {
  checkout_channels?: unknown
  hide_bank_channel_where_bank_transfer?: unknown
  paused_regions?: unknown
}

/**
 * Saves what an admin changed, leaving everything they did not send alone.
 * Refusals name the field, because this is an API someone is calling by hand.
 */
export async function writeAfriexSettings(
  container: MedusaContainer,
  patch: SettingsPatch
): Promise<AfriexSettings> {
  const values: Record<string, unknown> = {}

  if ("checkout_channels" in patch) {
    const channels = patch.checkout_channels
    if (channels === null) {
      values.checkout_channels = null
    } else if (
      Array.isArray(channels) &&
      channels.length &&
      channels.every(isCheckoutChannel)
    ) {
      values.checkout_channels = [...new Set(channels)]
    } else {
      throw new AfriexAdminError(
        "AFRIEX_INVALID_REQUEST",
        400,
        `\`checkout_channels\` must be null, or a list of ${CHECKOUT_CHANNELS.join(", ")}.`
      )
    }
  }

  if ("hide_bank_channel_where_bank_transfer" in patch) {
    if (typeof patch.hide_bank_channel_where_bank_transfer !== "boolean") {
      throw new AfriexAdminError(
        "AFRIEX_INVALID_REQUEST",
        400,
        "`hide_bank_channel_where_bank_transfer` must be true or false."
      )
    }
    values.hide_bank_channel_where_bank_transfer = patch.hide_bank_channel_where_bank_transfer
  }

  if ("paused_regions" in patch) {
    const regions = patch.paused_regions
    if (regions === null) {
      values.paused_regions = null
    } else if (pausedRegions(regions)) {
      values.paused_regions = pausedRegions(regions)
    } else {
      throw new AfriexAdminError(
        "AFRIEX_INVALID_REQUEST",
        400,
        "`paused_regions` must be null, or a map of method to region ids, like {\"checkout\": [\"reg_01\"]}."
      )
    }
  }

  if (!Object.keys(values).length) {
    throw new AfriexAdminError(
      "AFRIEX_INVALID_REQUEST",
      400,
      "Nothing to save. Send `checkout_channels`, `hide_bank_channel_where_bank_transfer` or `paused_regions`."
    )
  }

  const service = store(container)
  const [existing] = (await service.listSettings({ key: SINGLETON }, { take: 1 })) as
    | SettingRow[]
    | undefined[]

  if (existing) {
    await service.updateSettings({ id: existing.id, ...values })
  } else {
    try {
      await service.createSettings({ key: SINGLETON, ...values })
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error
      }
      // Another server created the row between the read and the write.
      const [raced] = (await service.listSettings({ key: SINGLETON }, { take: 1 })) as
        | SettingRow[]
        | undefined[]
      if (raced) {
        await service.updateSettings({ id: raced.id, ...values })
      }
    }
  }

  return readAfriexSettings(container)
}
