import { ExecArgs } from "@medusajs/framework/types"
import { Modules } from "@medusajs/framework/utils"

/**
 * Lists the most recent Afriex payment sessions, newest first, with everything
 * the webhook simulator needs: the session id (which is the reference), the
 * amount the plugin expects, and the virtual account's payment method id.
 *
 *   pnpm afriex:sessions
 */
export default async function listAfriexSessions({ container }: ExecArgs) {
  const paymentModule = container.resolve(Modules.PAYMENT)

  const sessions = await paymentModule.listPaymentSessions(
    {},
    { take: 50, order: { created_at: "DESC" } }
  )
  const afriex = sessions
    .filter((session) => session.provider_id.startsWith("pp_afriex_"))
    .slice(0, 10)

  if (!afriex.length) {
    console.log(
      "\nNo Afriex payment sessions yet. Take a cart to the payment step in the storefront first.\n"
    )
    return
  }

  console.log("\nRecent Afriex payment sessions (newest first):\n")

  for (const session of afriex) {
    const data = (session.data ?? {}) as Record<string, unknown>
    const extra = Array.isArray(data.extraDeposits) ? data.extraDeposits.length : 0

    console.log(`  ${session.id}`)
    console.log(`    expects        ${Number(session.amount)} ${session.currency_code.toUpperCase()}`)
    console.log(`    medusa status  ${session.status}`)
    console.log(`    afriex status  ${String(data.currentStatus ?? "-")}${extra ? `  (+${extra} extra deposit${extra > 1 ? "s" : ""})` : ""}`)
    console.log(`    method         ${String(data.collectionMethod ?? "-")}`)
    console.log(`    account id     ${String(data.afriexPaymentMethodId ?? "-")}`)
    console.log("")
  }

  const latest = afriex[0]!
  console.log("Pay the newest one (run from the repo root):\n")
  console.log(
    `  pnpm webhook:send --session ${latest.id} --amount ${Number(latest.amount)} --currency ${latest.currency_code.toUpperCase()}\n`
  )
}
