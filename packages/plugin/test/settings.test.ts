import { describe, expect, it, vi } from "vitest"
import type { MedusaContainer } from "@medusajs/framework/types"
import { AfriexAdminError } from "../src/lib/admin-error"
import { effectiveChannels } from "../src/lib/checkout-channels"
import { readAfriexSettings, writeAfriexSettings } from "../src/lib/settings"
import { GET as readRoute, POST as writeRoute } from "../src/api/admin/afriex/settings/route"
import { createPaymentsStore } from "./mocks/afriex.mock"

function container(store = createPaymentsStore()) {
  const scope = {
    resolve: (key: string) => (key === "afriex_payments" ? store : undefined),
  } as unknown as MedusaContainer
  return { scope, store }
}

function response() {
  const res: any = {}
  res.status = vi.fn((code: number) => {
    res.statusCode = code
    return res
  })
  res.json = vi.fn((body: unknown) => {
    res.body = body
    return res
  })
  return res
}

describe("what the store has decided about Afriex", () => {
  it("answers with the defaults until an admin saves anything", async () => {
    const { scope } = container()

    expect(await readAfriexSettings(scope)).toEqual({
      checkoutChannels: null,
      hideBankChannelWhereBankTransfer: false,
      pausedRegions: null,
    })
  })

  it("falls back to the defaults when the settings cannot be read", async () => {
    // A store that has not run the migration yet. These settings only narrow
    // what a shopper is offered, so failing to read them must not stop a payment.
    const broken = {
      resolve: () => ({
        listSettings: async () => {
          throw new Error("relation \"afriex_setting\" does not exist")
        },
      }),
    } as unknown as MedusaContainer

    expect((await readAfriexSettings(broken)).hideBankChannelWhereBankTransfer).toBe(false)
  })

  it("saves a choice, and leaves what was not sent alone", async () => {
    const { scope, store } = container()

    await writeAfriexSettings(scope, { checkout_channels: ["MOBILE_MONEY"] })
    const after = await writeAfriexSettings(scope, {
      hide_bank_channel_where_bank_transfer: true,
    })

    expect(after).toEqual({
      checkoutChannels: ["MOBILE_MONEY"],
      hideBankChannelWhereBankTransfer: true,
      pausedRegions: null,
    })
    expect(store.settings.size).toBe(1)
  })

  it("clears a choice with null, and refuses what it cannot mean", async () => {
    const { scope } = container()
    await writeAfriexSettings(scope, { checkout_channels: ["MOBILE_MONEY"] })

    expect((await writeAfriexSettings(scope, { checkout_channels: null })).checkoutChannels).toBeNull()

    for (const patch of [
      { checkout_channels: [] },
      { checkout_channels: ["BITCOIN"] },
      { hide_bank_channel_where_bank_transfer: "yes" },
      { paused_regions: [1] },
      {},
    ]) {
      await expect(writeAfriexSettings(scope, patch as never)).rejects.toBeInstanceOf(
        AfriexAdminError
      )
    }
  })

  it("keeps one row when two servers save at the same moment", async () => {
    const { scope, store } = container()

    await Promise.all([
      writeAfriexSettings(scope, { checkout_channels: ["MOBILE_MONEY"] }),
      writeAfriexSettings(scope, { hide_bank_channel_where_bank_transfer: true }),
    ])

    expect(store.settings.size).toBe(1)
  })

  it("reads and writes over the admin route, refusing a bad body with its code", async () => {
    const { scope } = container()

    const written = response()
    await writeRoute({ scope, body: { checkout_channels: ["MOBILE_MONEY"] } } as never, written)
    expect(written.body).toMatchObject({ checkoutChannels: ["MOBILE_MONEY"] })

    const read = response()
    await readRoute({ scope } as never, read)
    expect(read.body).toMatchObject({ checkoutChannels: ["MOBILE_MONEY"] })

    const refused = response()
    await writeRoute({ scope, body: { checkout_channels: "MOBILE_MONEY" } } as never, refused)
    expect(refused.statusCode).toBe(400)
    expect(refused.body).toMatchObject({ code: "AFRIEX_INVALID_REQUEST" })
  })
})

describe("hiding checkout's bank option", () => {
  it("hides it only where the currency is known to collect another way", () => {
    expect(
      effectiveChannels({
        currencyChannels: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"],
        hideBankChannel: true,
      })
    ).toEqual(["MOBILE_MONEY"])
  })

  it("keeps it when nothing else is known to work for the currency", () => {
    // NGN collects through the virtual account alone: hiding it would leave
    // the shopper with no way to pay.
    expect(
      effectiveChannels({ currencyChannels: ["VIRTUAL_BANK_ACCOUNT"], hideBankChannel: true })
    ).toEqual(["VIRTUAL_BANK_ACCOUNT"])
  })

  it("keeps it when the currency's channels are not configured at all", () => {
    expect(effectiveChannels({ hideBankChannel: true })).toEqual([
      "VIRTUAL_BANK_ACCOUNT",
      "MOBILE_MONEY",
    ])
  })

  it("still respects the config's cap and the admin's choice", () => {
    expect(
      effectiveChannels({
        configured: ["VIRTUAL_BANK_ACCOUNT"],
        adminChoice: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"],
        currencyChannels: ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY"],
        hideBankChannel: true,
      })
    ).toEqual(["VIRTUAL_BANK_ACCOUNT"])
  })
})
