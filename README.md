# @devalexllc/traffic-next

User-activity tracking for Next.js App Router apps, for deployments where a
hosted analytics product is not an option — air-gapped networks, or anywhere the
data must stay on infrastructure you control.

The browser never talks to your analytics backend. Events go to a first-party
route handler in your own app, which authenticates the caller, stamps identity
server-side, and forwards to whatever sink you supply.

## Why it is shaped this way

- **Same-origin ingest.** The client posts to `/api/traffic` on your own origin
  and the session cookie authenticates it. No token in `localStorage`, no CORS,
  no second origin to expose. This is also what makes `navigator.sendBeacon`
  usable — a beacon cannot set an `Authorization` header, so cookie auth is the
  only way to reliably capture the last event before a tab closes.
- **The client is never trusted.** `username`, `ip_address` and `application` are
  absent from the wire schema by construction and stamped on the server. A wrong
  client clock is clamped rather than believed.
- **Analytics never breaks a page.** Forwarding happens in `after()`, so the
  browser gets its `204` immediately and a sink outage degrades to dropped
  events, never to a slow or failing render.
- **No domain vocabulary.** This package ships to a public registry, so it knows
  nothing about your columns. Filter dimensions are a generic bag; you map them
  to real field names in your own repo.

## Install

```bash
npm install @devalexllc/traffic-next
```

Peers: `next >= 15.1`, `react >= 18`, `zod ^4`.

## Client

```tsx
// app/layout.tsx
import { Suspense } from "react";
import { TrafficProvider, RouteTracker } from "@devalexllc/traffic-next/client";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html>
      <body>
        <TrafficProvider staticState={{ application_version: "2.2.5" }}>
          {children}
          {/* RouteTracker calls useSearchParams(), which needs its own
              boundary or the whole tree opts out of static rendering. */}
          <Suspense fallback={null}>
            <RouteTracker extractFilters={(params) => ({ site: params.getAll("site") })} />
          </Suspense>
        </TrafficProvider>
      </body>
    </html>
  );
}
```

`extractFilters` returns a flat map of dimensions; `RouteTracker` sends it as the
event's `filters`, which reaches your `forward` as `payload.filters`. Return `{}`
(or omit the prop) to record none.

`useTraffic()` gives you `track()` for custom events anywhere below the provider.
It returns a no-op when no provider is mounted, so tests and stories need no
setup and a missing provider can never crash a page.

## Server

```ts
// app/api/traffic/route.ts
import { createTrafficRoute } from "@devalexllc/traffic-next/server";

export const { POST } = createTrafficRoute({
  application: "MyApp",
  getIdentity: async () => {
    const session = await auth();
    return { username: session?.user?.name, authorized: true };
  },
  forward: async (payload) => {
    // payload.filters is your generic bag — map it to your sink's schema here.
    await myAnalyticsClient.post(payload);
  },
});

export const dynamic = "force-dynamic";
```

### Importing the vocabulary in tests

`@devalexllc/traffic-next/server` statically imports `next/server`, which only
resolves inside a Next bundle — a plain Vitest or Node process cannot load it.
Import `TrafficEvent` / `TrafficType` from the **root** entry instead, which is
deliberately free of both React and Next:

```ts
import { TrafficEvent, TrafficType } from "@devalexllc/traffic-next";
```

Type-only imports from `/server` (`import type { TrafficPayload }`) are erased at
compile time and are fine anywhere.

Server-side events (a report download, a server action) can call your `forward`
directly — the browser never sees those, and a client-only tracker would miss
them entirely.

## Delivery

Events are queued in a ref, batched, and flushed on a debounce. Failures retry
with exponential backoff and jitter; `400`/`401`/`403` drop instead of retrying,
since none of them get better by resending. `pagehide` and `visibilitychange`
drain the queue through `sendBeacon`.

## Development

```bash
npm test          # vitest
npm run fmt       # oxfmt (oxfmt --check in CI)
npm run lint      # oxlint --type-aware --type-check; this is the type check too
npm run build     # tsgo -> dist
npx changeset     # describe a change; CI opens the version PR
```

`lefthook` formats staged files on commit and runs the linter on push; `npm ci`
installs the hooks through the `prepare` script.

Releases go out through the changesets action: merging the generated "Version
Packages" PR is what publishes. Nothing reaches npm without that merge.

Publishing uses [npm trusted publishing][tp] — the workflow exchanges a GitHub
OIDC token for short-lived credentials, so there is no npm token stored in the
repository. Every release carries a [provenance attestation][prov] linking the
tarball to the commit and workflow that built it:

```bash
npm audit signatures            # verify provenance of an installed copy
```

Trusted publishing is configured against this repository and `release.yml` on
npmjs.com. It depends on Node >= 24.20 (npm >= 11.19) on the runner, and on the
npm-side organization name matching GitHub's canonical casing exactly.

[tp]: https://docs.npmjs.com/trusted-publishers
[prov]: https://docs.npmjs.com/generating-provenance-statements

## License

Apache License 2.0 — see [LICENSE](LICENSE). Copyright 2026 Devalex LLC.
