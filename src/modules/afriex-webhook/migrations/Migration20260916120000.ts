import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260916120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "afriex_processed_webhook" (
        "id" text not null,
        "event_id" text not null,
        "processed_at" timestamptz not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "afriex_processed_webhook_pkey" primary key ("id")
      );
    `)

    // The unique constraint is what actually makes webhook handling idempotent:
    // the handler claims an event by inserting it, and relies on this index to
    // reject the second concurrent delivery of the same event.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_afriex_processed_webhook_event_id_unique" ON "afriex_processed_webhook" (event_id) WHERE deleted_at IS NULL;`
    )

    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_afriex_processed_webhook_deleted_at" ON "afriex_processed_webhook" (deleted_at) WHERE deleted_at IS NULL;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "afriex_processed_webhook" cascade;`)
  }
}
