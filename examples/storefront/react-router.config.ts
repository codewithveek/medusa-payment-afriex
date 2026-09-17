import type { Config } from "@react-router/dev/config"

export default {
  // Everything that touches Medusa runs in a loader or action, so the
  // publishable key and the cart id never reach the browser.
  ssr: true,
} satisfies Config
