import { describe, expect, it } from "vitest"
import { apiUrl } from "../src/admin/lib/api"

describe("where the admin screens send their calls", () => {
  it("stays on the same server when the dashboard is served by it", () => {
    // Medusa sets the backend URL to "/" in that case. Joined naively that is
    // "//admin/…", a protocol-relative URL to a host called "admin" — which is
    // exactly how every admin call once failed with "Failed to fetch".
    expect(apiUrl("/", "/admin/afriex/overview")).toBe("/admin/afriex/overview")
    expect(apiUrl("", "/admin/afriex/overview")).toBe("/admin/afriex/overview")
    expect(apiUrl(undefined, "/admin/afriex/overview")).toBe("/admin/afriex/overview")
  })

  it("goes to the configured server when the dashboard is hosted apart", () => {
    expect(apiUrl("https://api.shop.com", "/admin/afriex/overview")).toBe(
      "https://api.shop.com/admin/afriex/overview"
    )
    expect(apiUrl("https://api.shop.com/", "/admin/afriex/overview")).toBe(
      "https://api.shop.com/admin/afriex/overview"
    )
    expect(apiUrl("https://api.shop.com//", "admin/afriex/overview")).toBe(
      "https://api.shop.com/admin/afriex/overview"
    )
  })
})
