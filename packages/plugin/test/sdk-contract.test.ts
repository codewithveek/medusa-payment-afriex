import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { CheckoutService, HttpClient, ValidationError } from "@afriex/sdk"
import { SDK_ACCEPTED_CHECKOUT_CHANNELS } from "../src/lib/checkout-channels"

/**
 * What the plugin relies on the installed Afriex SDK to do. These fail the day
 * an SDK upgrade changes the behaviour, so the plugin is changed on purpose
 * rather than by accident.
 */

const REQUEST = {
  amount: 500000,
  currency: "NGN",
  merchantReference: "payses_contract",
  redirectUrl: "https://shop.example.com/return",
  customer: { name: "Ada", email: "ada@example.com", phone: "+2348012345678", countryCode: "NG" },
}

describe("the checkout channels the SDK sends", () => {
  it("are exactly the ones the plugin allows through", async () => {
    const post = vi.fn(async () => ({ data: { checkoutUrl: "https://pay.afriex.com/pay/x" } }))
    const service = new CheckoutService({ post } as any)
    const accepted: string[] = []

    for (const channel of ["VIRTUAL_BANK_ACCOUNT", "MOBILE_MONEY", "CARD"] as const) {
      try {
        await service.createSession({ ...REQUEST, channels: [channel] })
        accepted.push(channel)
      } catch (error) {
        expect(error).toBeInstanceOf(ValidationError)
      }
    }

    // When the SDK starts accepting CARD, add it to SDK_ACCEPTED_CHECKOUT_CHANNELS.
    expect(accepted).toEqual([...SDK_ACCEPTED_CHECKOUT_CHANNELS])
  })
})

describe("SDK retries", () => {
  let server: Server
  let baseUrl: string
  const hits = { POST: 0, GET: 0 }

  beforeAll(async () => {
    server = createServer((req, res) => {
      hits[req.method as "POST" | "GET"] = (hits[req.method as "POST" | "GET"] ?? 0) + 1
      res.writeHead(503, { "content-type": "application/json" })
      res.end(JSON.stringify({ code: "SERVICE_UNAVAILABLE", error: "down" }))
    })
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())))

  it("never re-sends a POST, so a checkout reference is never submitted twice", async () => {
    const client = new HttpClient({
      apiKey: "sk",
      baseUrl,
      timeout: 5000,
      maxRetries: 3,
      retryDelay: 1,
      retryableStatusCodes: [503],
      enableLogging: false,
    } as any)

    await expect(client.post("/checkout-session", {})).rejects.toBeDefined()
    await expect(client.get("/transaction")).rejects.toBeDefined()

    expect(hits.POST).toBe(1)
    // The same configuration does retry a GET: the retry settings are live.
    expect(hits.GET).toBe(4)
  })
})
