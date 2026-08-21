# Read-Only Observability Proxy + MCP Rework

Expose PAT's centralized log store (OpenObserve / `pat-observability`) to Pat and the
operator **from anywhere**, safely — so Pat can debug its own behavior / draft bug
reports on the road, and the MCP/CLI drop the `flyctl proxy` dance.

Status: **outlined, not built** (2026-06-25). Gated parts noted below.

## Why

- The store is currently 6PN/flycast-only, reached via `flyctl proxy 5080:5080` (see
  `logs-mcp.ts` `ensureReady`). That doesn't work from a phone / away from the laptop, and
  it's a per-consumer hassle.
- We want Pat to self-debug. But OpenObserve **OSS has no RBAC / no read-only credential**
  — the root basic-auth is full admin, and the store holds message bodies + a person
  directory (PII). So we **must not** expose the raw store publicly (see
  an internal security review).

## Architecture

```
pat-observability.plsd.app  →  pat-observability-proxy (PUBLIC)  →  OpenObserve (flycast/private)
                                  - endpoint allowlist (read-only)
                                  - validates PAT_OBSERVABILITY_TOKEN
                                  - injects OO admin basic-auth server-side
```

OpenObserve keeps **no public IP**; only the proxy is public. The custom domain points at
the **proxy**, never the raw store.

## Components

### 1. `pat-observability-proxy` (new Fly app, ~50 lines Hono/Bun)
- Public IP; reaches OpenObserve over flycast (6PN).
- **Endpoint allowlist** (this *is* the read-only enforcement — no write endpoints reachable,
  so no SQL parsing needed):
  - ✅ `POST /api/{org}/_search` — the workhorse: queries, aggregations (GROUP BY in SQL),
    time-windowed reads (start/end in body), **and live-watch via polling** (our Monitor
    pattern polls `_search`, so this one endpoint covers "streaming" too).
  - ✅ `GET /api/{org}/streams/{stream}/schema` — the `schema` tool.
  - ✅ `GET /api/{org}/streams` — list streams (minor).
  - ➕ optional freebies (low-risk reads): `GET /api/{org}/{stream}/_values`, `GET /healthz`.
- **Auth in:** validate bearer `PAT_OBSERVABILITY_TOKEN`. **Auth out:** inject OO admin
  basic-auth (admin creds are the proxy's secret, never public, never in Pat's reach).
- Secrets on the app: internal OO URL + OO admin creds + expected `PAT_OBSERVABILITY_TOKEN`.

**Deliberately NOT in the proxy:**
- ❌ Ingestion (`/_json`, `/_bulk`) — the forwarder/shipper write **directly over 6PN,
  privately**. The public proxy is read-only; keeping ingest off it is the point.
- ❌ WebSocket / SSE streaming search. Decision (2026-06-25): **skip in v1.** Value is only
  the live-watch path (sub-second vs ~3–5s polling), and the floor is ingest latency (~1–2s)
  anyway, so the win is marginal; WS adds real complexity (Upgrade handshake, bidirectional
  relay, awkward WS auth) and long-lived connections erode the "small auditable allowlist"
  security property. **Leave a clean seam for SSE** (the easier half, fits Monitor's stdout
  model) if push-based tail ever becomes a real need.

### 2. `PAT_OBSERVABILITY_TOKEN` (distinct credential type — an internal security review)
- Authorizes read-only log queries and nothing else; separate from admin/owner/any other token.
- Stored in the **OneCLI vault, host-matched to the proxy hostname**, so the agent path never
  holds it (gateway injects). Caveat : a container *can* read injected creds — but a
  read-only-log token is low-stakes if leaked, and the admin creds + raw store stay protected.

### 3. MCP + CLI rework
- `pat-observability/plugin/logs-mcp.ts`: **delete the `flyctl proxy` subsystem**
  (`ensureReady`/spawn/healthz, ~lines 89–137). Point `OPENOBSERVE_URL` at the proxy;
  swap basic-auth → `Authorization: Bearer ${PAT_OBSERVABILITY_TOKEN}`. `query`/`schema`/
  `resolve_person` tools otherwise unchanged (they only hit `_search`/schema).
- `pat-observability/plugin/.mcp.json`: replace `OPENOBSERVE_URL`/`USER`/`PASSWORD` with the
  proxy URL + the token.
- `pat-observability/scripts/patobs` + `scripts/proxy.sh`: same URL+token swap; `proxy.sh`
  becomes optional (direct-admin debugging only). Net: one HTTPS URL + one token, works from
  the road.

### 4. Agent-side path — "Pat debugs himself" (SEPARATE, gated)
Give Pat a container-side capability (a `query_logs` MCP tool, or expose `patobs`) that hits
the proxy; the vault injects the token by host-match. **Gate this behind the security pass**
don't widen Pat's reach until that's addressed).

## Sequencing / effort
1. Build the proxy + secrets (~half day, self-contained).
2. MCP/CLI URL+token swap + delete proxy subsystem (~half day).
3. Point `pat-observability.plsd.app` at the proxy; rotate OO root password.
4. (Later, post-security-pass) the agent-facing query capability.

## Open decisions
- One shared `PAT_OBSERVABILITY_TOKEN` vs per-consumer (laptop vs agent) tokens — start with
  one, split if needed.
- Confirm deployed OpenObserve version's exact `_search`/schema paths (it's on `:latest`,
  floating — pin while here).

## Files this plan touches
- NEW: `pat-observability/proxy/` (the Hono app) + its `fly.toml`.
- `pat-observability/plugin/logs-mcp.ts`, `plugin/.mcp.json`
- `pat-observability/scripts/patobs`, `scripts/proxy.sh`
- Cross-ref: an internal security review .
