import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import {
  AFRIEX_REFERENCE_CREATED,
  AFRIEX_REFERENCE_SUPERSEDED,
  recordReference,
  supersedeReference,
  type ReferenceCreatedEvent,
  type ReferenceSupersededEvent,
} from "../lib/ledger"

/**
 * Writes the payment-reference ledger. The providers cannot reach the plugin's
 * own module — they run inside the payment module's container — so they
 * announce each reference they hand out, and each one Medusa takes back, as an
 * event instead.
 */
export default async function afriexPaymentReferenceHandler({
  event,
  container,
}: SubscriberArgs<ReferenceCreatedEvent | ReferenceSupersededEvent>): Promise<void> {
  if (event.name === AFRIEX_REFERENCE_CREATED) {
    await recordReference(container, event.data as ReferenceCreatedEvent)
    return
  }

  if (event.name === AFRIEX_REFERENCE_SUPERSEDED) {
    await supersedeReference(container, event.data as ReferenceSupersededEvent)
  }
}

export const config: SubscriberConfig = {
  event: [AFRIEX_REFERENCE_CREATED, AFRIEX_REFERENCE_SUPERSEDED],
  context: { subscriberId: "afriex-payment-reference" },
}
