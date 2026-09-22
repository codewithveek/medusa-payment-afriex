import { countryFromE164, toE164 } from "./phone"

type AddressLike = {
  first_name?: string | null
  last_name?: string | null
  company?: string | null
  phone?: string | null
  country_code?: string | null
  is_default_billing?: boolean | null
} | null | undefined

type CustomerLike = {
  email?: string | null
  first_name?: string | null
  last_name?: string | null
  company_name?: string | null
  phone?: string | null
  addresses?: AddressLike[] | null
} | null | undefined

/** A cart, or an order for collections that have no cart. */
export type CheckoutPayer = {
  email?: string | null
  billing_address?: AddressLike
  shipping_address?: AddressLike
  customer?: CustomerLike
}

export type CheckoutCustomer = {
  name: string
  email: string
  phone: string
  countryCode: string
}

/**
 * Builds the customer block Afriex's checkout requires — name, email, an E.164
 * phone and a country — from what the store already holds about the payer.
 * Medusa does not pass any of it to the provider for a guest cart, so it is
 * read here, on the server, and the storefront is never trusted to supply it.
 *
 * The phone and its country always come from the same record. Normalising a
 * local number with another address's dialling code would produce a valid-
 * looking number that belongs to someone else.
 */
export function buildCheckoutCustomer(
  payer: CheckoutPayer,
  defaultCountryCode: string | undefined
): { customer: CheckoutCustomer } | { missing: "email" | "phone" } {
  const email = (payer.email ?? payer.customer?.email ?? "").trim()
  if (!email) {
    return { missing: "email" }
  }

  const defaultAddress =
    payer.customer?.addresses?.find((address) => address?.is_default_billing) ??
    payer.customer?.addresses?.[0]

  const phoneRecords: { phone?: string | null; country_code?: string | null }[] = [
    payer.billing_address ?? {},
    payer.shipping_address ?? {},
    { phone: payer.customer?.phone, country_code: defaultAddress?.country_code },
    defaultAddress ?? {},
  ]

  let phone: string | undefined
  let countryCode: string | undefined

  for (const record of phoneRecords) {
    if (!record.phone?.trim()) {
      continue
    }
    const country = record.country_code?.toUpperCase() || undefined
    const normalised = toE164(record.phone, country ?? defaultCountryCode)
    if (normalised) {
      phone = normalised
      countryCode = country ?? countryFromE164(normalised) ?? defaultCountryCode?.toUpperCase()
      break
    }
  }

  if (!phone || !countryCode) {
    return { missing: "phone" }
  }

  const nameSources = [payer.billing_address, payer.shipping_address, payer.customer]
  const name =
    nameSources
      .map((source) =>
        [source?.first_name, source?.last_name].filter(Boolean).join(" ").trim()
      )
      .find(Boolean) ||
    payer.billing_address?.company ||
    payer.customer?.company_name ||
    email.split("@")[0]!

  return { customer: { name, email, phone, countryCode } }
}
