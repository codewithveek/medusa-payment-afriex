import { Migration } from "@medusajs/framework/mikro-orm/migrations"

/**
 * The store-wide Afriex settings, as one row. The unique `key` is what keeps it
 * to one row: two servers starting together cannot each insert their own.
 */
export class Migration20260923140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "afriex_setting" (
        "id" text not null,
        "key" text not null,
        "checkout_channels" jsonb null,
        "hide_bank_channel_where_bank_transfer" boolean not null default false,
        "paused_regions" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "afriex_setting_pkey" primary key ("id")
      );
    `)

    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_afriex_setting_key_unique" ON "afriex_setting" (key) WHERE deleted_at IS NULL;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "afriex_setting" cascade;`)
  }
}
