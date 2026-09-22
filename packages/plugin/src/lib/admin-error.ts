/**
 * A refusal an admin can act on, from one of the plugin's admin routes. It
 * carries an HTTP status and a stable code for the dashboard, plus a
 * plain-language message.
 */
export class AfriexAdminError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}
