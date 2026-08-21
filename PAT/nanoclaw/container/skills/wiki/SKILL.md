---
name: wiki
description: Maintain a persistent cross-session wiki for Pat — the durable memory layer that survives container restarts. Activate when ingesting a new source (URL, document, call summary), answering a recall query ("do you remember…", "what did we decide about…", "look it up"), or running a lint pass. Pat is the sole writer; never let another agent edit `wiki/` files.
---

# Pat's Wiki — Cross-Session Memory

Pat has a persistent knowledge base in the group folder, modelled on Karpathy's
LLM Wiki pattern. It survives every container restart and every Fly deploy. It
is **the** mechanism by which Pat accumulates context about Gavan, the team,
ongoing projects, and the AI-safety work that drives PAT.

You — the back-mind — are the **sole writer**. The front-mind does not edit
wiki files. Voice never edits wiki files. Don't let scheduled tasks or
agent-to-agent calls write to `wiki/` either — if they ask, do the write
yourself after confirming with Gavan when appropriate.

## Layout

```
wiki/
  index.md          # content catalog, grouped by category — read first
  log.md            # append-only chronological record
  .lock             # presence sentinel during writes (atomic-rename)
  users/            # per-person pages (Gavan, teammates)
  feedback/         # how Gavan wants Pat to behave (corrections + confirmed approaches)
  projects/         # ongoing work, motivations, deadlines
  references/       # external systems, API quirks, deployed-state facts
  calls/            # call summaries written after a conversation ends
  concepts/         # cross-cutting ideas (AI safety framing, mini-app teachings, etc.)
sources/            # raw curated documents the wiki was derived from (read-only)
```

## What kinds of artifacts belong here

Pat's wiki is biased toward **voice-conversational artifacts**, not toward
a generic knowledge base:

- **Call summaries** — after a call ends, write a `calls/YYYY-MM-DD-<slug>.md`
  capturing what was discussed, decisions made, and follow-ups owed. One per
  call, not one per turn.
- **Team preferences** — how Gavan wants Pat to behave, what tone, what
  verbosity, what to never do. These live in `feedback/`. Lead with the rule,
  add a `**Why:**` line and a `**How to apply:**` line so future-you can
  judge edge cases instead of blindly following.
- **AI-safety framing** — Pat is built at Palisade Research. When the
  conversation touches AI safety, capabilities evaluation, misuse research,
  or related themes, capture the framing in `concepts/` so subsequent calls
  inherit it.
- **Mini-app teachings** — when Gavan teaches Pat how to use a new tool,
  service, or workflow ("here's how Fly secrets work", "OneCLI vault gateway
  lives at host XYZ"), capture it as a `references/` page. Future calls
  consult these instead of asking Gavan to re-explain.
- **People** — Gavan's teammates, collaborators, callers. Each gets a
  `users/<name>.md` page. Update it as new facts surface.
- **Projects** — what's actively in progress, why, by when. Project memories
  decay fast — date-stamp them and prune ruthlessly during lint.

What does NOT belong here:
- Code patterns, file paths, project structure → derivable by reading the repo.
- Git history → `git log` is authoritative.
- Debugging fix recipes → the commit message + the code are authoritative.
- Anything already in CLAUDE.md / AGENTS.md → don't duplicate.

## Operations

### Ingest — when Gavan provides a source

When Gavan drops a source (URL, PDF, file path, call audio summary, image)
or points you at a folder of them:

1. **One at a time.** Read the source. Discuss takeaways briefly. Then
   create/update **every** relevant wiki page — summary, entity pages,
   concept pages, cross-references, `index.md`, `log.md` — and *fully
   finish* that source before moving to the next. Never batch-read multiple
   sources and then process them together; that produces shallow generic
   pages instead of deep integration.
2. **Full text, not summaries.** `WebFetch` returns a summary — for wiki
   ingestion use bash to pull the actual content:
   ```bash
   curl -sLo sources/<slug>.html "<url>"   # web page
   curl -sLo sources/<slug>.pdf "<url>"    # PDF
   ```
   Then read the local file. For webpages where curl gets a JS-only
   shell, use `agent-browser` if installed.
3. **Update the index.** Every ingest touches `wiki/index.md`. Add the new
   page(s) under the right category with a one-line summary.
4. **Append to the log.** `wiki/log.md` gets one line per ingest:
   ```
   ## [YYYY-MM-DD] ingest | <source title or slug>
   ```

### Query — when Gavan asks Pat to recall

When Gavan says "do you remember…", "what did we decide about…", "look that
up", "check the wiki":

1. **Read `wiki/index.md` first** to locate the right page(s).
2. **Grep for entities** if the index doesn't point you somewhere obvious:
   ```bash
   grep -rli "<entity>" wiki/
   ```
3. Read the relevant pages.
4. Answer with citations — name the wiki page(s) the answer came from. The
   front-mind speaks the answer to Gavan; back-mind output is rendered
   through the voice layer, so keep citations proportionate (a sentence,
   not a footnote dump).
5. **Good answers compound** — if Gavan asks a synthesis question and
   you compose a fresh answer, consider filing the answer itself back into
   the wiki as a new page so the next query inherits it.

### Lint — periodic health check

Look for:
- **Contradictions** — two pages making opposite claims; flag the older one.
- **Stale claims** — `projects/` and `references/` pages with dates older than
  a few weeks; verify against current state before trusting.
- **Orphans** — pages not linked from any other page or the index.
- **Missing concept pages** — entities mentioned 3+ times with no dedicated page.
- **Index gaps** — pages on disk not in `index.md`.
- **Cross-reference holes** — pages that mention a known entity by name without
  linking to its page.

Report findings as a markdown summary; offer to fix issues. Don't auto-fix
contradictions without Gavan's input — those are the load-bearing cases.

## Single-writer discipline + atomic-rename lock

Pat is the sole writer. To prevent torn writes (rare in single-writer-mode
but cheap insurance), use an **atomic-rename lock** for multi-file ingest
passes:

```bash
# Acquire (atomic; fails if .lock already exists)
( set -C; echo "$$:$(date -u +%FT%TZ)" > wiki/.lock ) || {
  echo "wiki is locked — another write in progress"; exit 1
}
trap 'rm -f wiki/.lock' EXIT INT TERM

# … do all the writes …

# Release happens via the trap on exit.
```

The lock is presence-only — its content is informational (pid + timestamp)
for debugging if it ever wedges. Stale locks older than 1 hour can be
cleared safely.

Single-file edits (one append to `log.md`, one edit to `index.md`) don't
need the lock — the filesystem write is already atomic at the page
granularity. Use the lock for ingests that touch 5+ pages.

## Index.md format

```markdown
# Wiki Index

Pat's persistent memory across sessions. Last updated: <YYYY-MM-DD>.

## Users

- [Gavan](users/gavan.md) — primary user; voice-first; runs Palisade Research
- [<teammate>](users/<slug>.md) — <one-line hook>

## Feedback (how to behave)

- [<rule title>](feedback/<slug>.md) — <one-line hook>

## Projects (active work)

- [<project>](projects/<slug>.md) — <status + one-line hook>

## References (external systems, deployed-state facts)

- [<resource>](references/<slug>.md) — <one-line hook>

## Calls

- [YYYY-MM-DD <topic>](calls/<slug>.md) — <one-line hook>

## Concepts

- [<concept>](concepts/<slug>.md) — <one-line hook>
```

Keep each line under ~150 chars. The index is read on every query — long
entries pollute the working set.

## Log.md format

Append-only. Every entry starts with `## [YYYY-MM-DD]`:

```markdown
## [2026-05-12] ingest | Karpathy LLM-Wiki gist
Read the gist; created concepts/llm-wiki-pattern.md; updated index.

## [2026-05-12] query | "did Gavan ever explain how Fly secrets work"
Found references/pat-nanoclaw-env-bridge.md; cited; no new page.

## [2026-05-13] lint
Found 2 orphan pages (calls/2026-04-…, references/old-…); confirmed with
Gavan; archived orphans to wiki/archive/.
```

`grep "^## \[" wiki/log.md | tail -5` shows the last 5 entries.

## How this differs from auto-memory

Pat's harness has Claude Code's auto-memory at
`~/.claude/projects/<cwd>/memory/`. That's per-claude-process memory — it's
scoped to one process and one CLAUDE.md tree. **The wiki is different**:
it's per-group, durable across all containers ever spawned for this group,
and Pat owns it as a structured product, not an automatically-managed
side-effect.

Auto-memory captures "things I want to remember next time". The wiki
captures "things Pat is responsible for maintaining as a coherent body of
knowledge." Auto-memory writes happen implicitly; wiki writes are explicit
deliberate operations.

When in doubt: if it's a single fact about Gavan's preference and you'd
like it surfaced in future sessions, auto-memory is fine. If it's a
synthesis, a project state, a call summary, a teaching, or anything that
benefits from cross-referencing with other knowledge — it's a wiki page.

## Practical tone for the voice layer

Wiki writes happen mid-conversation. Don't narrate every file edit out
loud — the front-mind will surface progress through narration. Long wiki
operations should still complete in the background; just don't make
Gavan listen to "writing concepts/foo.md… writing users/bar.md…".
A brief "noted, that's going in the wiki" or "found it — let me check"
is usually all the user needs.
