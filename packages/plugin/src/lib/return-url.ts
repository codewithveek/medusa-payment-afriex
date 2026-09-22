/** Replaced with the order's id in `checkout.returnUrl`. */
export const ORDER_ID_PLACEHOLDER = "{order_id}"

const MAX_RETURN_URL_LENGTH = 2048

/**
 * Checks the configured return URL at boot. Returns the reason it is unusable,
 * or undefined when it is fine.
 */
export function returnUrlProblem(value: unknown): string | undefined {
  if (typeof value !== "string" || !value) {
    return "must be a URL"
  }

  const placeholders = value.split(ORDER_ID_PLACEHOLDER).length - 1
  if (placeholders > 1) {
    return `may contain ${ORDER_ID_PLACEHOLDER} at most once`
  }

  let url: URL
  try {
    url = new URL(value.replace(ORDER_ID_PLACEHOLDER, "order_placeholder"))
  } catch {
    return "must be a URL"
  }

  if (url.protocol !== "https:") {
    return "must use https (Afriex only redirects to HTTPS URLs)"
  }
  if (url.username || url.password) {
    return "must not contain credentials"
  }
  if (placeholders === 1 && !url.pathname.includes("order_placeholder")) {
    return `may use ${ORDER_ID_PLACEHOLDER} only in the path`
  }
  return undefined
}

/**
 * The URL Afriex sends the shopper back to.
 *
 * A storefront may ask for another URL, but only on an origin the store
 * configured — otherwise anyone could use a store's checkout to send payers to
 * a site of their choosing. The order id is written into the path when the
 * configured URL asks for it, so nothing depends on Afriex keeping a query
 * string.
 */
export function buildRedirectUrl(input: {
  returnUrl: string
  allowedReturnOrigins?: string[]
  requested?: unknown
  orderId?: string | null
}): { url: string } | { refused: string } {
  let template = input.returnUrl

  if (input.requested !== undefined && input.requested !== null && input.requested !== "") {
    const requested = String(input.requested)
    const configuredOrigin = new URL(input.returnUrl.replace(ORDER_ID_PLACEHOLDER, "x")).origin
    const allowed = new Set([configuredOrigin, ...(input.allowedReturnOrigins ?? [])])

    let url: URL
    try {
      url = new URL(requested.replace(ORDER_ID_PLACEHOLDER, "x"))
    } catch {
      return { refused: "The return URL is not a valid URL." }
    }

    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      requested.length > MAX_RETURN_URL_LENGTH ||
      !allowed.has(url.origin)
    ) {
      return { refused: "The return URL is not on an origin this store allows." }
    }

    template = requested
  }

  const orderId = input.orderId ? encodeURIComponent(input.orderId) : ""
  return { url: template.split(ORDER_ID_PLACEHOLDER).join(orderId) }
}
