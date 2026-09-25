import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  isRouteErrorResponse,
} from "react-router"
import type { Route } from "./+types/root"
import "./app.css"

// PolySans is Afriex's typeface but it is licensed, so it is not loaded here;
// Inter is the fallback afriex.com itself uses.
export const links: Route.LinksFunction = () => [
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap",
  },
]

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* Inline, so the browser does not ask for a /favicon.ico that isn't there. */}
        <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect width='16' height='16' rx='4' fill='%230075FF'/></svg>" />
        <Meta />
        <Links />
      </head>
      <body>
        <header className="site-header">
          <div>
            <a href="/" className="wordmark">
              Afriex Example Store
            </a>
            <span className="badge">demo</span>
          </div>
        </header>
        <main>{children}</main>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  )
}

export default function App() {
  return <Outlet />
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : "Unknown error"

  // The most common failure by far is the backend not being up yet.
  const unreachable = message.toLowerCase().includes("fetch failed")

  return (
    <section className="card">
      <h1>Something went wrong</h1>
      {unreachable ? (
        <p className="note">
          Could not reach the Medusa backend. Start it with <code>pnpm dev</code>{" "}
          in <code>examples/medusa-backend</code>, and check{" "}
          <code>MEDUSA_BACKEND_URL</code> in this app&rsquo;s <code>.env</code>.
        </p>
      ) : null}
      <pre className="error">{message}</pre>
    </section>
  )
}
