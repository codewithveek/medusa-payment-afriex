---
"medusa-payment-afriex": minor
---

Offer each Afriex method only where Afriex can collect the currency, in every country Afriex serves — not just Nigeria.

- **Afriex's coverage, built in.** The plugin carries Afriex's published deposit coverage per currency: which take a virtual account, which take mobile money, which are still coming. A method that cannot collect a region's currency is refused on the cart, before any order exists, with a code (`AFRIEX_BANK_TRANSFER_UNAVAILABLE_FOR_CURRENCY`, `AFRIEX_CHECKOUT_UNAVAILABLE_FOR_CURRENCY`). Your options win over the table: `bankTransfer.currencies` and `checkout.currencyChannels`.
- **`GET /store/afriex/methods?region_id=…`** tells a storefront which Afriex methods to show in a region, and what Afriex's page will offer there, so it can say "mobile money" in Kenya and "bank transfer" in Nigeria.
- **The admin says why.** The Settings page warns where a method is on but Afriex cannot collect; each region's page shows the reason, and what the payment page offers in that currency.
- **Afriex's compliance review** for a new currency now answers `AFRIEX_BANK_TRANSFER_AWAITING_APPROVAL`, with the currency named in the log and a note on the Settings page.
- **The country comes from the order** — the address, else the currency's own country — and is never assumed to be Nigeria. `defaultCountryCode` is only a last resort.
- **Smallest units follow ISO 4217**: a franc or a shilling with no smaller coin is sent as a whole unit, without configuration. `minorUnitExponents` still overrides.
- The example storefront asks the new route, words each option for the currency, and prefills an address in the region's country.
