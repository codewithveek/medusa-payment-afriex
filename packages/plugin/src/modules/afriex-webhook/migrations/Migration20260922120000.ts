import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260922120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "afriex_processed_webhook" add column if not exists "completed_at" timestamptz null;`
    )

    // Every row written before this column existed belongs to an event that
    // finished: a failed one released its claim by deleting the row.
    this.addSql(
      `update "afriex_processed_webhook" set "completed_at" = "processed_at" where "completed_at" is null;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "afriex_processed_webhook" drop column if exists "completed_at";`
    )
  }
}
