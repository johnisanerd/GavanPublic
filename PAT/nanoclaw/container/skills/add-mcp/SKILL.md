---
name: add-mcp
description: How to add a NEW third-party MCP server to yourself correctly. Read this whenever a user asks you to add/wire/connect an MCP server (Exa, Linear, a vendor's tool server, etc.). Covers picking the right transport (prefer the vendor's hosted/remote endpoint over npx/stdio), wiring auth through the OneCLI vault WITHOUT ever handling the key, and what to tell the human.
---

# add-mcp — wiring a new MCP server the right way

When a user asks you to add an MCP server, you do it with the **`add_mcp_server`** tool.
The hard part isn't the tool call — it's choosing the right shape so the server is
**secure** (the API key never touches you or the DB) and **reliable**. Follow this.

## 1. Prefer the vendor's REMOTE (hosted HTTP) MCP over stdio/npx

Most MCP vendors offer a **hosted endpoint** (a URL) *and* a local `npx <pkg>` stdio
server. **Always prefer the hosted URL.** Reasons:

- Remote = pure wiring (a URL + a header). No binary to install, no `npx` fetch at
  runtime, no version pinning.
- Remote auth flows through the OneCLI vault by host-match — **the real key never sits
  in your container env**. The stdio path needs the key in env (less secure) and an
  extra install step.

So: **look up the vendor's docs first** (use `firecrawl_search` / the `firecrawl` skill)
and find their **hosted MCP URL + which HTTP header carries the API key**. Only fall
back to stdio if they genuinely have no hosted endpoint — and if you do, tell the human
it's the less-secure path.

## 2. Never put the real key in `headers`. Use `secret_name`.

`add_mcp_server` has a dedicated path for this. For an authed remote server, pass:

| arg | what | example (Exa) |
|---|---|---|
| `url` | the hosted MCP endpoint | `https://mcp.exa.ai/mcp` |
| `secret_name` | the **canonical key name** (NOT the value) | `EXA_API_KEY` |
| `auth_header` | the header the key goes in (default `Authorization`) | `x-api-key` |
| `auth_format` | value template (default `Bearer {value}`) | `{value}` |

⚠️ **The default `auth_format` is `Bearer {value}`. Many vendors don't use Bearer** —
e.g. Exa wants the raw key in `x-api-key`, so `auth_format` must be `{value}`. Check the
vendor's docs and set `auth_header` / `auth_format` to match, or auth will silently 401.

This single call wires the server AND registers credential routing (so the vault injects
the real key at the server's host at egress). **You never see or pass the key value.**

```
add_mcp_server(
  name="exa", url="https://mcp.exa.ai/mcp",
  secret_name="EXA_API_KEY", auth_header="x-api-key", auth_format="{value}",
)
```

## 3. Tell the human exactly what to add (the tool result tells you)

The tool returns the precise name to ask for — relay it. The key value is supplied
out-of-band by a human as **`AGENT_<secret_name>`** (e.g. `AGENT_EXA_API_KEY`) — the
operator adds it to the deployment's `.env.remote` file and ships it with the
`secrets-push` script. Say something like: *"Added the Exa MCP. To activate it, add the
Exa API key as `AGENT_EXA_API_KEY` to `.env.remote` and run secrets-push — it'll switch
on automatically."*

Do **not** ask the user to paste the key to you — you can't take it. It goes into the
credential store directly. And pass `secret_name` **unprefixed** (`EXA_API_KEY`, not
`AGENT_EXA_API_KEY`) — the system derives the prefixed operator name itself.

## 4. One call, then wait

`add_mcp_server` is fire-and-forget with admin approval, so it returns *"submitted, pending"* —
that's normal, not a failure. **One call is enough.** No need to re-submit or reach for another
method: use the `add_mcp_server` tool — don't shell out to `ncl groups config add-mcp-server`
for this (it's the developer CLI and does the same thing more awkwardly, with its own approvals).

Tell the user it's submitted + which credential to add, and wait for the approval. If the
credential isn't in the vault yet when the admin approves, the server is **parked** and
activates **automatically** the moment the credential lands — you'll get a system message,
the container restarts, and the new tools appear. Then verify (list your tools / test call).
No re-request, no manual restart, nothing is broken while it waits.

If something genuinely comes back wrong (a real error, not just "pending"), surface it to the
user rather than silently retrying a different way.

## stdio fallback — ONLY if the vendor has no hosted endpoint

Reach for this **only** when your docs search found no hosted URL at all — **never** as a
retry after you've already submitted a remote one:
```
add_mcp_server(name="foo", command="npx", args=["-y", "foo-mcp-server"])
```
It runs a local binary and needs its key in the container env (less secure) — flag that to
the human, and prefer a hosted endpoint if one exists.

## Quick rules

- **One `add_mcp_server` call is enough** — "pending" is normal; use the tool, not `ncl`.
- **Hosted URL > stdio.** Search the vendor's docs for the remote endpoint first.
- **`secret_name`, never a real key in `headers`.**
- **Match `auth_header`/`auth_format` to the vendor** (don't assume `Bearer`).
- **Relay the `AGENT_<key>` name**; never accept the key value yourself.
- Then wait for approval; surface a genuine error, don't silently retry another way.
