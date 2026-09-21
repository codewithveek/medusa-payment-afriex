import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { AFRIEX_PROCESSED_WEBHOOK_RETENTION_DAYS } from "../lib/constants"
import { AFRIEX_WEBHOOK_MODULE } from "../modules/afriex-webhook"
import type AfriexWebhookModuleService from "../modules/afriex-webhook/service"

const BATCH = 1000

/**
 * The idempotency table only needs to remember events for as long as Afriex
 * might redeliver them. Rows older than the retention window are removed in
 * batches so the table does not grow with every webhook the store ever saw.
 */
export default async function pruneAfriexProcessedWebhooks(
  container: MedusaContainer
): Promise<void> {
  const store = container.resolve<AfriexWebhookModuleService>(AFRIEX_WEBHOOK_MODULE)
  const logger = container.resolve<Logger>("logger")
  const cutoff = new Date(
    Date.now() - AFRIEX_PROCESSED_WEBHOOK_RETENTION_DAYS * 24 * 60 * 60 * 1000
  )

  let removed = 0

  for (;;) {
    const stale = await store.listProcessedWebhooks(
      { processed_at: { $lt: cutoff } },
      { select: ["id"], take: BATCH }
    )

    if (!stale.length) {
      break
    }

    await store.deleteProcessedWebhooks(stale.map((row) => row.id))
    removed += stale.length

    if (stale.length < BATCH) {
      break
    }
  }

  if (removed) {
    logger.info(`Pruned ${removed} Afriex processed-webhook rows older than ${AFRIEX_PROCESSED_WEBHOOK_RETENTION_DAYS} days.`)
  }
}

export const config = {
  name: "afriex-prune-processed-webhooks",
  schedule: "0 3 * * *",
}
