import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * What Afriex reports about a hosted checkout session once it exists: its own
 * id, and when its payment link stops accepting payment. Until this arrives the
 * plugin works off an assumed lifetime, so the columns are nullable and every
 * reference handed out before this migration simply keeps the estimate.
 */
export class Migration20260923120000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(
      `alter table if exists "afriex_payment_reference" add column if not exists "afriex_session_id" text null;`
    )
    this.addSql(
      `alter table if exists "afriex_payment_reference" add column if not exists "expires_at" timestamptz null;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(
      `alter table if exists "afriex_payment_reference" drop column if exists "afriex_session_id";`
    )
    this.addSql(
      `alter table if exists "afriex_payment_reference" drop column if exists "expires_at";`
    )
  }
}
