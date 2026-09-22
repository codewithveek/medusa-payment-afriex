import { Migration } from "@medusajs/framework/mikro-orm/migrations"

export class Migration20260922140000 extends Migration {
  override async up(): Promise<void> {
    this.addSql(`
      create table if not exists "afriex_payment_reference" (
        "id" text not null,
        "reference" text not null,
        "method" text check ("method" in ('bank_transfer', 'checkout')) not null,
        "payment_session_id" text not null,
        "payment_collection_id" text null,
        "amount" text not null,
        "currency_code" text not null,
        "account_id" text null,
        "amount_minor" text null,
        "superseded_at" timestamptz null,
        "late_payments" jsonb null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "afriex_payment_reference_pkey" primary key ("id")
      );
    `)

    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_afriex_payment_reference_reference_unique" ON "afriex_payment_reference" (reference) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_afriex_payment_reference_payment_collection_id" ON "afriex_payment_reference" (payment_collection_id) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_afriex_payment_reference_deleted_at" ON "afriex_payment_reference" (deleted_at) WHERE deleted_at IS NULL;`
    )

    this.addSql(`
      create table if not exists "afriex_settlement" (
        "id" text not null,
        "payment_collection_id" text not null,
        "payment_session_id" text not null,
        "transaction_id" text not null,
        "created_at" timestamptz not null default now(),
        "updated_at" timestamptz not null default now(),
        "deleted_at" timestamptz null,
        constraint "afriex_settlement_pkey" primary key ("id")
      );
    `)

    // The whole point of this table: one settlement per payment collection,
    // enforced by the database whatever lock the servers share.
    this.addSql(
      `CREATE UNIQUE INDEX IF NOT EXISTS "IDX_afriex_settlement_payment_collection_id_unique" ON "afriex_settlement" (payment_collection_id) WHERE deleted_at IS NULL;`
    )
    this.addSql(
      `CREATE INDEX IF NOT EXISTS "IDX_afriex_settlement_deleted_at" ON "afriex_settlement" (deleted_at) WHERE deleted_at IS NULL;`
    )
  }

  override async down(): Promise<void> {
    this.addSql(`drop table if exists "afriex_settlement" cascade;`)
    this.addSql(`drop table if exists "afriex_payment_reference" cascade;`)
  }
}
