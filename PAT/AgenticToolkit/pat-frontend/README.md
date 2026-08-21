# pat-frontend

The operator control-plane + observability dashboard for the Palisade Agentic
Toolkit (PAT).

A Clerk-OAuth, react-router SPA served by a small Hono/Bun server, deployed as a
single Fly app (`pat-frontend` prod, `pat-frontend-staging`). Operators sign in
with their `@palisaderesearch.org` Google account (via Clerk); the server proxies
the data routes to nanoclaw, swapping the operator/viewer auth for the upstream
admin token.

## Stack

- Vite + React 19 + TypeScript, `react-router-dom` v7 (BrowserRouter)
- Tailwind CSS v4 (no JS config — `@theme` block in `src/index.css`) + shadcn/ui
  components (radix primitives, hand-rolled to the TheTest design tokens; DM Sans
  / DM Mono brand fonts)
- `@tanstack/react-query` for the DB/People data fetching; `@tanstack/react-table`
  for the Database browser grid
- Clerk (`@clerk/react` client, `@clerk/backend` + `@clerk/hono` server) for
  operator OAuth
- Hono on Bun for the server (`bun:sqlite` builtin — better-sqlite3 is only the
  Node/vitest fallback, see the `trustedDependencies` note in `package.json`)

## Auth model

- **Operators** authenticate with a Clerk session. pat-frontend serves the SPA and
  `/api` on the same origin, so Clerk's `__session` cookie rides every request —
  including the Timeline's `EventSource`, which can't set headers. The server
  verifies it with `@clerk/backend`'s `authenticateRequest` (no middleware, so it
  works on streaming routes). Gate = exact `@palisaderesearch.org` domain match
  (`isOperatorEmail`, `server/auth.ts`).
- **Machine / iframe embeds** (e.g. the pat-web avatar side-pane) have no Clerk
  session, so the **legacy `?token=<viewer>` path survives** for them only: the
  client's `?token=` bypasses the login gate (`App.tsx`), and the API accepts the
  `PAT_VIEWER_TOKEN` (`requireOperatorOrToken`). Operators never receive or use it.
- First operator login mints a `people`-spine person row (`/api/me` →
  `ensurePersonForOperator`), idempotent + fail-soft. Per-person roles
  (`person_roles`) exist but are **not yet enforced** — the UI still gates on the
  operator-email allowlist.

## Layout

```
src/
  main.tsx                        — ClerkProvider + BrowserRouter root; reads the
                                    runtime-injected window.__PUBLIC_ENV__ key
  App.tsx                         — auth gate + <Routes> (AdminShell + route tree)
  routes/
    LoginPage.tsx                 — signed-out Clerk sign-in
    SessionLayout.tsx             — Session chrome: the one session selector +
                                    connection pill + clear, over Timeline / Logs
    DatabaseView.tsx              — /database — central v2.db browser (proxies
                                    nanoclaw /admin/db; read-only)
    PeopleView.tsx                — /people — people spine + handle link/unlink
    MyHandlesView.tsx             — /my-handles — the operator's own identifiers +
                                    per-channel pairing (QR / deep links)
  components/
    shell/                        — admin-shell, app-sidebar, nav-*, capture-phone
    Timeline.tsx                  — interrupt-aware call timeline
    EventStream.tsx               — front-mind / back-mind scrolling log columns
    StatePanel.tsx, DataTable.tsx, EventDetailsModal.tsx
    ui/                           — shadcn/radix primitives
  hooks/
    use-event-buffer.ts           — the realtime data layer (SSE → dedup'd rolling
                                    buffer → thread selection → front/back split);
                                    call ONCE high in the tree
    use-event-stream.ts           — EventSource subscription
    use-dashboard-state.ts        — derived state reducer
  lib/
    api.ts                        — react-query fetch helpers (token-aware)
    table-reference.ts            — hand-maintained DB data dictionary (see AGENTS.md)
    event-render.ts, debug-surface.ts, utils.ts
  types/
    log-events.ts                 — mirror of realtime/src/log-events.ts
server/
  index.ts                        — Hono: serves the SPA, injects PUBLIC_ env,
                                    /api/me, /api/logs.tail (SSE) + /api/logs.jsonl
                                    proxies to nanoclaw /admin/logs.*
  auth.ts                         — Clerk operator auth + legacy viewer-token path
  public-env.ts                   — PUBLIC_<NAME> env → window.__PUBLIC_ENV__
  routes-db.ts                    — /api/db* → nanoclaw /admin/db proxy
  routes-people.ts                — /api/people, /api/handles (+ link/unlink writes)
  routes-capabilities.ts          — front-mind capability list
  people.ts                       — people-spine reads + login→person mint
  pairing-targets.ts              — per-channel pairing contacts / deep links / QR
  nanoclaw.ts                     — upstream host/scheme/token helpers
```

Forensics note: `/api/logs.tail` + `/api/logs.jsonl` proxy nanoclaw's
`/admin/logs.*` — the underlying host log surface. For "what happened" questions
prefer the centralized **patobs** store first (see `docs/forensics.md` / the
`/pat-logs` skill); this dashboard is the live view, not the canonical archive.

## Performance / gotchas

Load-bearing, each cost hours to find — don't relearn them:

- **Timeline: no per-frame RAF relayout.** `buildTrackData` (`components/Timeline.tsx`)
  is memoized off buffer mutations and a coarse ~250ms `nowTick`. Driving it from a
  60Hz RAF re-lays-out every absolute-positioned span each frame (worst during
  `cartesia.agent-text-sent` streaming) — the buffer changes constantly during a live
  call, so the window already slides on its own.
- **Dedupe set must fit the full daily backlog.** nanoclaw's `/admin/logs.*` replays
  the entire persistent JSONL on every proxy reconnect (~35k events/day). `seenKeysRef`
  (`hooks/use-event-buffer.ts`) caps at 250k and *clears on overflow* — never FIFO-trim,
  which ages out old keys and re-floods the buffer on every reconnect.
- **Coalesce cumulative Cartesia text.** `cartesia.{agent,user}-text-sent` each carry
  the full text-so-far (30+ events per TTS turn); `use-event-buffer.ts` replaces the
  previous in-flight event of the same kind+thread in place instead of appending.
- **Reach nanoclaw over `.internal`, not `.flycast`.** The proxy talks to
  `pat-nanoclaw.internal:8767` over 6PN (`server/nanoclaw.ts`); flycast would need a
  `[[services.ports]]` block pat-nanoclaw doesn't expose.
- **Debug surfaces** (`lib/debug-surface.ts`): `window.__pat` (buffer + dedupe stats),
  `window.__patTimeline` (playhead, var-at-playhead, per-track last line).

## Running locally

```bash
bun install

# Vite dev server (port 5173). Its /api is proxied to a real upstream —
# defaults to prod; override with PAT_DEV_UPSTREAM (e.g. your local server).
bun run dev

# The Hono server, talking to a local nanoclaw. Needs Clerk keys for the
# operator path (or set ADMIN_DEV_NO_AUTH=1 to stub an operator without Clerk):
PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_… \
CLERK_SECRET_KEY=sk_test_… \
PAT_ADMIN_TOKEN=dev-admin \
NANOCLAW_INTERNAL_HOST=localhost:8767 \
  bun run dev:server

# Embed/machine path (no Clerk): set PAT_VIEWER_TOKEN=dev-viewer and open
#   http://localhost:5173/?token=dev-viewer
```

`PUBLIC_*` env vars are read from `.env` in dev by the `pat-public-env` vite plugin
(`vite.config.ts`) — the SAME `window.__PUBLIC_ENV__` mechanism the prod server
uses, so the client only ever reads `window.__PUBLIC_ENV__`, never `import.meta.env`.

## Building for prod

```bash
bun run build       # check-renderers + tsc -b && vite build → ./dist
bun run start       # serves dist/ + the proxy on :8787
bun run test        # vitest (auth gate + render smoke tests)
```

## Deploying to Fly

Deploy from **this directory** with the per-env toml (see AGENTS.md → Deploying):

```bash
env -u FLY_API_TOKEN -u FLY_ACCESS_TOKEN \
  flyctl deploy -c fly.staging.toml --remote-only -a pat-frontend-staging
```

**No build-arg.** The old `VITE_`-baked Clerk key is gone — a deploy can no longer
ship a keyless client. The publishable key is a plain **runtime** Fly secret,
injected into the page at request time by the Hono server (`server/public-env.ts`
→ `window.__PUBLIC_ENV__`). A plain `flyctl deploy` ships a working client; just
ensure the secrets are set.

Secrets:

| Secret | Where | Purpose |
|--------|-------|---------|
| `PUBLIC_CLERK_PUBLISHABLE_KEY` | browser (runtime) + server | Clerk `pk_…` (public value; same `pk_test_…` for both envs today) |
| `CLERK_SECRET_KEY` | server only | Clerk `sk_…` for `@clerk/backend` session verification |
| `PAT_ADMIN_TOKEN` | server only | upstream nanoclaw admin token the proxy presents |
| `PAT_VIEWER_TOKEN` | server only | legacy viewer token — accepted from `?token=` machine/embed callers |

```bash
flyctl secrets set PUBLIC_CLERK_PUBLISHABLE_KEY=pk_… CLERK_SECRET_KEY=sk_… \
  -a pat-frontend-staging
# Recover a lost pk_ from a running bundle:
flyctl ssh console -a pat-frontend-staging -C "printenv PUBLIC_CLERK_PUBLISHABLE_KEY"
```

The viewer/admin tokens stay distinct: a leaked viewer token grants read-only
monitor access only, and rotates without disturbing the nanoclaw admin credential
the proxy uses upstream.
