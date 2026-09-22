/**
 * Whether an insert failed because a unique constraint rejected it.
 *
 * 23505 is Postgres' unique_violation; MikroORM surfaces it as a
 * UniqueConstraintViolationException whose message keeps the constraint name.
 * Medusa's generated module service catches both and rethrows a MedusaError
 * reading "... with <column>: <value>, already exists.", which keeps neither —
 * so that phrasing has to be matched too, or a unique violation escapes as an
 * ordinary failure. Callers use this only on tables whose one unique column is
 * the one they are inserting against.
 */
export function isUniqueViolation(error: unknown): boolean {
  const code = (error as { code?: string })?.code
  const message = (error as { message?: string })?.message ?? ""

  return (
    code === "23505" ||
    /unique constraint|duplicate key|already exists/i.test(message)
  )
}
