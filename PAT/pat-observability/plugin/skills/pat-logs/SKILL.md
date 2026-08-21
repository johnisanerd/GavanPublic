---
name: pat-logs
description: Retrieve and read PAT's centralized logs to answer "what happened on that call/turn", "why did Pat say X", "is this happening now", or any forensics/debugging question. Queries the pat-observability OpenObserve store (structured events incl. debug + raw signal/dockerd output, both prod and staging) via the patobs MCP tools. Use BEFORE reaching for flyctl logs.
---

# Querying PAT's centralized logs

All PAT logs live in **one** OpenObserve store (`pat-observability`), queried via the
`mcp__patobs__query` (SQL) and `mcp__patobs__schema` tools. This replaces the old
three-surface hunt (host `/admin/logs.jsonl` + per-session `container.stderr.log` +
`flyctl logs -a pat-transports`) — it's all here now, both prod and staging.

## The two streams

| Stream | What | Use for |
|---|---|---|
| `pat_events` | Structured JSONL from nanoclaw (both envs). Front-mind, routing, errors, back-mind container telemetry, **full debug incl. `llm.call` prompt/response traces**. | Almost everything: "what happened on call X", "why did Pat say Y", latency, tool calls, narration. |
| `pat_raw` | Raw stdout/stderr of every `pat-*` Fly app: signal-cli daemon, dockerd, OneCLI gateway, build/crash output. | Signal decrypt errors, container/init crashes, infra-level failures not in the structured stream. |

## How to query

`mcp__patobs__query` takes `sql` (table = stream name), `since` (lookback window like
`"1h"`, `"30m"`, `"2d"` — widen for old calls; default 1h), and `size`.

**Slice by env** — one store holds both: `WHERE env='prod'` or `WHERE env='staging'`.

**Nested fields are flattened with underscores** (depth 3): `data.latency_ms` →
`data_latency_ms`, `data.tool` → `data_tool`. Call `mcp__patobs__schema` first if unsure
of a column name.

### Recipes

```sql
-- Everything on one call, in order (the bread-and-butter forensic query)
SELECT * FROM pat_events WHERE thread_id = 'call-7af3b2' ORDER BY _timestamp

-- Why did Pat say X — the LLM traces for a session (debug; always present here)
SELECT ts, kind, data_model, data_prompt, data_response
FROM pat_events WHERE kind LIKE 'llm.call%' AND session_id = 'sess-abc' ORDER BY _timestamp

-- Errors/fatals on staging in the last 2h
SELECT ts, kind, source, level FROM pat_events
WHERE env='staging' AND level IN ('error','fatal') ORDER BY _timestamp

-- Tool calls on a call
SELECT ts, data_tool, data_input FROM pat_events
WHERE thread_id='call-7af3b2' AND kind='detail.row-received' AND data_type='tool-pre'

-- Signal daemon trouble (raw stream): decrypt NPEs, sealed-sender drops
-- (pat_raw has NO ts column — use timestamp. match_all works on pat_raw only.)
SELECT timestamp, app, message FROM pat_raw
WHERE app='pat-transports' AND (message LIKE '%getServerGuid%' OR message LIKE '%getSender%' OR message LIKE '%NullPointer%')
-- or, full-text: SELECT timestamp, app, message FROM pat_raw WHERE match_all('NullPointer')

-- Is it happening NOW? recent activity for a user/thread (use a short window)
SELECT ts, kind, level FROM pat_events WHERE thread_id='call-x' ORDER BY _timestamp DESC
-- with since="5m"
```

## Querying by Person (not handle)

Most events are keyed by a per-channel handle (`data_sender_id` / `platform_id`). To slice
by *who*, **resolve the Person to their handles first, then query by handle.**

**Names never appear beside message bodies** — `pat_events` carries only an opaque
`data_person_id`. The id↔name/handles **directory lives in a separate stream,
`pat_enrichment`** (kept fresh by `people.*` events + a periodic dump of nanoclaw's
people tables). Resolve against it with **`mcp__patobs__resolve_person`** (or the
`patobs resolve` CLI):

```
resolve_person("John")
→ [{ person_id: "person-abc…", display_name: "Ada Lovelace",
     handles: ["signal:<redacted-uuid>","pstn:+1808…"], identifiers: [...] }]
```

Then query `pat_events` by those handles — the **general, retroactive** path (works for
every event that carries `data_sender_id`, and for old data logged before the person was
linked):

```sql
-- what John said, across all channels, with content
SELECT ts, data_channel_type, data_text FROM pat_events
WHERE kind='inbound.received'
  AND data_sender_id IN ('signal:<redacted-uuid>','pstn:+18081234567')
ORDER BY _timestamp
```

**One-hop convenience:** `inbound.received` and `routing.message-routed` ALSO stamp the
opaque `data_person_id`, so if you already have a `person_id` from `resolve_person` you can
skip the handle list. `routing.message-routed` is the **session ↔ person anchor** (carries
both `session_id` and `data_person_id` on every channel — the universal routing funnel),
so you can fan a person out to all their session events (`llm.call`, `narrator.*`, `tts.*`,
…, which carry neither name nor person):

```sql
-- everything (incl. back-mind) for John's sessions — join via the anchor
SELECT * FROM pat_events WHERE session_id IN (
  SELECT session_id FROM pat_events
  WHERE kind='routing.message-routed' AND data_person_id='person-abc…'
) ORDER BY _timestamp
```

`data_person_id` is `null` for senders not yet linked to a Person (strangers / pre-pairing)
— that's correct (we didn't know who they were yet); fall back to `data_sender_id` /
`platform_id` for those. The **handle list from `resolve_person` is the path that still
works for them retroactively** once they're linked.

CLI form (for monitors / loops): `patobs resolve "John" [--env prod|staging]` prints one
`{person_id, display_name, handles}` JSON object per matched person.

## Watching live (wake-ups & monitors)

The MCP tools only run inside a turn — they can't watch unattended. To **wake on the
first matching event** or **get pinged on every occurrence**, use the
**`scripts/patobs` CLI** (same store + SQL, but shell-callable, so Claude Code's
`Monitor` / background `Bash` / `/loop` verbs can consume its stdout). It prints one
JSON row per line. Prereq: `scripts/proxy.sh` running (the store is flycast-only); the
loops should `|| true` each query so a proxy blip doesn't kill them, and ingest latency
is ~1–2s so keep polls at ~3–5s.

```
patobs "SELECT ts,kind,thread_id FROM pat_events WHERE env='staging'" --since 30s
patobs --schema pat_events
```

**Wake me on the FIRST matching event** ("go place the call, ping me when it lands") →
`Bash` with `run_in_background` + an `until` loop that exits on first hit (one notification):
```bash
until [ -n "$(patobs "SELECT thread_id FROM pat_events WHERE env='staging' AND kind LIKE 'inbound%'" --since 30s || true)" ]; do sleep 3; done
```

**Ping me on EVERY occurrence** ("tell me each time a Signal message arrives this session")
→ `Monitor` (persistent) polling for rows past a cursor, emitting one line each:
```bash
last=$(( $(date +%s) * 1000000 ))
while true; do
  rows=$(patobs "SELECT _timestamp,kind,platform_id FROM pat_events WHERE env='staging' AND _timestamp > $last ORDER BY _timestamp" --since 5m || true)
  [ -n "$rows" ] && { echo "$rows"; last=$(printf '%s\n' "$rows" | jq -s 'max_by(._timestamp)._timestamp'); }
  sleep 4
done
```

## Rules

- **Dispatch on `kind`**, never grep a message string for structured data — the schema is
  per-kind. `kind` categories: `chat.*`, `request-layer.*`, `narrator.*`, `tts.*`, `llm.call`,
  `detail.row-received`, `session.*`, `signal.*`, `bargein.*`, `scenario.*`, …
- **Pull the full matching set, then summarize** — don't pre-truncate. Use `size` generously.
- **Find a thread/session id first** if you don't have one: query recent `inbound.*` /
  `session.*` rows for the user's `platform_id`, grab the `thread_id`, then pull the full call.
- **Debug is included** — unlike the old dashboard (which hid debug by default), this store
  has `llm.call` and all debug rows. No `include_debug` flag needed.
- For a call timeline with overlap/interrupt markers, `scripts/pat-trace.py` (in the
  agentic_toolkit repo) still renders the nicest ASCII view; this skill is for ad-hoc SQL.
