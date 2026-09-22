import type { MedusaContainer } from "@medusajs/framework/types"
import { AFRIEX_WEBHOOK_MODULE } from "../modules/afriex-webhook"
import type AfriexWebhookModuleService from "../modules/afriex-webhook/service"
import { isUniqueViolation } from "./db-errors"

/**
 * How long a claim may stay unfinished before a redelivery may take it over.
 * Far longer than any real reconciliation, which is bounded by the lock and
 * workflow timeouts; a claim this old belongs to a process that died.
 */
const STALE_CLAIM_MS = 5 * 60 * 1000

/**
 * - `claimed`: this delivery owns the event and must process it.
 * - `duplicate`: an earlier delivery already processed it.
 * - `in_progress`: an earlier delivery is processing it right now. Answering
 *   200 here would end Afriex's retries while that attempt can still fail, so
 *   the caller answers with a retryable error instead.
 */
export type ClaimResult = "claimed" | "duplicate" | "in_progress"

function resolveStore(container: MedusaContainer): AfriexWebhookModuleService {
  return container.resolve(AFRIEX_WEBHOOK_MODULE)
}

/**
 * Claims an event before it is processed, rather than checking for it and
 * inserting afterwards. Afriex retries deliveries, and two retries can arrive
 * close enough together to both pass a read-then-write check — the unique
 * constraint on `event_id` is what actually makes this safe, so the insert has
 * to happen first and its failure is the signal.
 */
export async function claimEvent(
  container: MedusaContainer,
  eventId: string
): Promise<ClaimResult> {
  const store = resolveStore(container)

  if (await tryInsert(store, eventId)) {
    return "claimed"
  }

  const [existing] = await store.listProcessedWebhooks(
    { event_id: eventId },
    { take: 1 }
  )

  if (!existing) {
    // Released between the insert and this read: the other attempt failed a
    // moment ago. Let Afriex's next retry claim it cleanly.
    return "in_progress"
  }

  if (existing.completed_at) {
    return "duplicate"
  }

  if (Date.now() - new Date(existing.processed_at).getTime() < STALE_CLAIM_MS) {
    return "in_progress"
  }

  // The delivery that claimed this event died without finishing or releasing
  // it. Take it over; the unique constraint still decides between two
  // redeliveries racing to do the same.
  await store.deleteProcessedWebhooks(existing.id)
  return (await tryInsert(store, eventId)) ? "claimed" : "in_progress"
}

/** Marks a claimed event as fully processed, so later redeliveries are duplicates. */
export async function completeClaim(
  container: MedusaContainer,
  eventId: string
): Promise<void> {
  const store = resolveStore(container)
  const [claimed] = await store.listProcessedWebhooks(
    { event_id: eventId },
    { take: 1 }
  )

  if (claimed) {
    await store.updateProcessedWebhooks({ id: claimed.id, completed_at: new Date() })
  }
}

/**
 * Releases a claim so a later retry of the same event can be processed. Called
 * only when reconciliation threw — an event that failed halfway must not be
 * permanently swallowed by its own idempotency record.
 */
export async function releaseClaim(
  container: MedusaContainer,
  eventId: string
): Promise<void> {
  const store = resolveStore(container)
  const [claimed] = await store.listProcessedWebhooks(
    { event_id: eventId },
    { take: 1 }
  )

  if (claimed) {
    await store.deleteProcessedWebhooks(claimed.id)
  }
}

async function tryInsert(
  store: AfriexWebhookModuleService,
  eventId: string
): Promise<boolean> {
  try {
    await store.createProcessedWebhooks({
      event_id: eventId,
      processed_at: new Date(),
    })
    return true
  } catch (error) {
    if (isUniqueViolation(error)) {
      return false
    }
    throw error
  }
}
