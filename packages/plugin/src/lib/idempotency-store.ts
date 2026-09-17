import type { MedusaContainer } from "@medusajs/framework/types"
import { AFRIEX_WEBHOOK_MODULE } from "../modules/afriex-webhook"
import type AfriexWebhookModuleService from "../modules/afriex-webhook/service"

function resolveStore(container: MedusaContainer): AfriexWebhookModuleService {
  return container.resolve(AFRIEX_WEBHOOK_MODULE)
}

/**
 * Claims an event before it is processed, rather than checking for it and
 * inserting afterwards. Afriex retries deliveries, and two retries can arrive
 * close enough together to both pass a read-then-write check — the unique
 * constraint on `event_id` is what actually makes this safe, so the insert has
 * to happen first and its failure is the signal.
 *
 * Returns false when the event was already claimed by an earlier delivery.
 */
export async function claimEvent(
  container: MedusaContainer,
  eventId: string
): Promise<boolean> {
  try {
    await resolveStore(container).createProcessedWebhooks({
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

function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  const message = (error as { message?: string })?.message ?? ""

  // 23505 is Postgres' unique_violation; MikroORM surfaces it as a
  // UniqueConstraintViolationException whose message keeps the constraint name.
  return (
    code === "23505" ||
    /unique constraint|duplicate key/i.test(message)
  )
}
