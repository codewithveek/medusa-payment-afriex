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

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header className="site-header">
          <a href="/" className="wordmark">
            Afriex Example Store
          </a>
          <span className="badge">demo</span>
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
