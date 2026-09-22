/**
 * Country dialling codes for the countries a Medusa store selling through
 * Afriex is likely to see, keyed by ISO 3166-1 alpha-2. Enough to turn a
 * local number into E.164 and to read a country back from one; not a full
 * numbering plan.
 */
const DIAL_CODES: Record<string, string> = {
  // Africa
  NG: "234", GH: "233", KE: "254", UG: "256", TZ: "255", RW: "250", ET: "251",
  ZA: "27", CM: "237", CI: "225", BJ: "229", SN: "221", TG: "228", BF: "226",
  ML: "223", NE: "227", ZM: "260", ZW: "263", MW: "265", MZ: "258", EG: "20",
  MA: "212", DZ: "213", TN: "216", SL: "232", LR: "231", GM: "220", GN: "224",
  CD: "243", CG: "242", GA: "241", AO: "244", BW: "267", NA: "264", SD: "249",
  SO: "252", DJ: "253", BI: "257", MG: "261", MU: "230",
  // Elsewhere
  US: "1", CA: "1", GB: "44", IE: "353", FR: "33", DE: "49", NL: "31", BE: "32",
  ES: "34", IT: "39", PT: "351", CH: "41", AT: "43", SE: "46", NO: "47", DK: "45",
  FI: "358", PL: "48", AE: "971", SA: "966", QA: "974", IN: "91", CN: "86",
  JP: "81", AU: "61", NZ: "64", BR: "55", MX: "52", TR: "90",
}

/** For a `+` number with no country beside it: the first country listed for a code wins. */
const COUNTRY_BY_DIAL_CODE = Object.entries(DIAL_CODES).reduce<Record<string, string>>(
  (map, [country, code]) => {
    map[code] ??= country
    return map
  },
  {}
)

const E164 = /^\+[1-9]\d{7,14}$/

/**
 * Normalises a phone number to E.164 using the country it was entered for.
 * Accepts "+2348012345678", "002348012345678", "2348012345678" and the local
 * "08012345678". Returns undefined when the number cannot be made valid —
 * better to ask the shopper than to send Afriex a number that is not theirs.
 */
export function toE164(raw: string | null | undefined, countryCode: string | null | undefined): string | undefined {
  if (!raw) {
    return undefined
  }

  let digits = raw.trim().replace(/[\s().-]/g, "")

  if (digits.startsWith("00")) {
    digits = `+${digits.slice(2)}`
  }

  if (digits.startsWith("+")) {
    return E164.test(digits) ? digits : undefined
  }

  if (!/^\d+$/.test(digits)) {
    return undefined
  }

  const dial = countryCode ? DIAL_CODES[countryCode.toUpperCase()] : undefined
  if (!dial) {
    return undefined
  }

  // Already carries the country code, without the plus.
  if (digits.startsWith(dial) && E164.test(`+${digits}`) && digits.length > dial.length + 6) {
    return `+${digits}`
  }

  // A local number: drop the national trunk prefix.
  const national = digits.replace(/^0+/, "")
  const candidate = `+${dial}${national}`
  return E164.test(candidate) ? candidate : undefined
}

/** The country an E.164 number belongs to, when the dialling code is one this table knows. */
export function countryFromE164(phone: string): string | undefined {
  if (!E164.test(phone)) {
    return undefined
  }
  const digits = phone.slice(1)
  for (let length = 3; length >= 1; length--) {
    const country = COUNTRY_BY_DIAL_CODE[digits.slice(0, length)]
    if (country) {
      return country
    }
  }
  return undefined
}
