/** Set by Medusa's dashboard build when the admin is served apart from the server. */
declare const __BACKEND_URL__: string | undefined

/**
 * Joins the configured backend URL and an API path.
 *
 * Medusa's dashboard sets `__BACKEND_URL__` to `"/"` when it is served by the
 * server itself. Joined naively that gives `//admin/...`, which a browser reads
 * as a protocol-relative URL whose *host* is `admin` — every call fails with
 * "Failed to fetch". So trailing slashes are dropped first.
 */
export function apiUrl(base: string | undefined | null, path: string): string {
  const root = (base ?? "").replace(/\/+$/, "")
  return `${root}${path.startsWith("/") ? path : `/${path}`}`
}

/** Where the admin API lives, as configured for the dashboard build. */
export const BACKEND_URL: string =
  typeof __BACKEND_URL__ !== "undefined" && __BACKEND_URL__ ? __BACKEND_URL__ : ""

export type ApiResult<T = any> = { status: number; body: T }

/** One call to the admin API, with the session cookie and no thrown errors. */
export async function call<T = any>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const response = await fetch(apiUrl(BACKEND_URL, path), {
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      ...init,
    })
    return { status: response.status, body: await response.json().catch(() => ({} as T)) }
  } catch (error) {
    // The server is unreachable. Callers show `message`, so give them one.
    return {
      status: 0,
      body: { message: (error as Error).message || "The server could not be reached." } as T,
    }
  }
}

export const post = <T = any>(path: string, body: unknown): Promise<ApiResult<T>> =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) })

/** Afriex amounts are decimal strings; this is only ever for display. */
export function money(amount: string | number | null | undefined, currency?: string | null): string {
  if (amount === null || amount === undefined || amount === "") {
    return "—"
  }
  const value = Number(amount)
  const text = Number.isFinite(value) ? value.toLocaleString() : String(amount)
  return currency ? `${text} ${currency.toUpperCase()}` : text
}
