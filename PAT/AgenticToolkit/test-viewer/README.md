# test-viewer

Tiny web UI for reviewing nanoclaw smoketest results.

## Run

```bash
node server.mjs
# then open http://127.0.0.1:9100
```

That's it — no install, no build. Uses only Node built-ins (`http`, `fs`, `path`, `url`).

Override port with `PORT=9200 node server.mjs`.

## What it reads

The server points at the sibling smoketest data dir:

```
../nanoclaw/data/v2-sessions/_smoketest/<scenario-id>/
  result.json        ← scenario, passed, durationMs, outcomes[]
  transcript.json    ← startTs, entries[], metrics{}
  transcript.md      ← (not used by viewer; rendered from json)
  call.wav           ← (only on --call runs)
  user.wav
  agent.wav
```

Each subdir is one scenario invocation. The data dir has no native concept of a "run" —
the viewer reconstructs runs by grouping scenarios whose `startTs` values are within
60 seconds of one another (consecutive). Scenario timestamps fall back to the dir name
(e.g. `baseline-2026-05-05T20-00-01-587Z`) and finally to filesystem mtime if needed.

## What you see

**Top bar:** brand, a "switch run" dropdown trigger (defaults to the latest run, click
to expose a list of all runs), summary line ("N runs · M scenarios · X pass · Y fail"),
refresh button. The runs list is hidden by default to keep the UI quiet — open it via
the dropdown trigger when you want a different run.

**Scenarios sidebar (left, desktop):** one row per scenario in the selected run.
Green/red dot, scenario name, duration. Click to select. On tablet/mobile the sidebar
collapses into a horizontal pill row.

**Detail surface (main):**

- Scenario name + a **PASS/FAIL pill** at the top. Hover the pill to see the judge
  reason as a tooltip.
- Run id + start time, monospace metadata.
- A single collapsed **"Details" accordion** (closed by default). When opened it
  reveals: metric grid (duration, ack/chat latency, user turns, agent utterances/chats,
  error fallbacks), the judge box (verdict + full reason), and the per-step pass/fail
  list.
- **Audio block** (when the scenario was a `--call` run): tabs for `call.wav` /
  `user.wav` / `agent.wav`, native `<audio controls>` with `preload="metadata"` and
  `controlsList="nodownload noplaybackrate noremoteplayback"` to hide OS-level
  share/AirPlay/download/playback-rate menus, custom 1x/1.5x/2x speed buttons, and a
  `M:SS / M:SS` time readout.
- **Transcript** (always visible, scrolls): monospace grid with `[+Nms]` offsets,
  color-coded source labels (user blue, agent-chat purple, agent-utterance violet,
  system gray, judge amber).

### Audio ↔ transcript sync

When `call.wav` is selected the viewer highlights the transcript line that lines up
with the current audio position. Each entry's offset is `entry.ts - transcript.startTs`,
matched against `audio.currentTime * 1000`. Only `call.wav` is synced (the per-side
`user.wav` / `agent.wav` streams have different alignment). If the audio runs more
than ~33 seconds past the last transcript entry, sync is disabled automatically rather
than risk highlighting the wrong line.

### Responsive layout

- **Desktop (≥ 1024px)**: top bar + sidebar (scenarios) + detail.
- **Tablet (640–1024px)**: scenarios collapse to a horizontal pill row beneath the top
  bar; detail occupies the full remaining height.
- **Mobile (< 640px)**: same as tablet, with tighter padding and slightly smaller fonts.

Pure CSS media queries — no responsive framework, no build step.

## API surface (server.mjs)

| Path | Returns |
|------|---------|
| `/` | `public/index.html` |
| `/style.css`, `/app.js` | static frontend |
| `/api/runs` | flat summary array of all scenarios (newest first) |
| `/api/run-groups` | `{ groups: [{ id, startTs, endTs, count, passCount, failCount, scenarioNames[] }], scenarios: [...] }` |
| `/api/run/:name` | `{ name, files: [...] }` |
| `/api/run/:name/<file>` | raw bytes (`result.json`, `transcript.json`, `*.wav`, …) |

The `/api/run-groups` endpoint groups scenarios into runs by computing the gap between
consecutive `startTs` values (`RUN_GROUP_GAP_MS = 60_000` in `server.mjs`); the flat
`scenarios` array in the same response feeds the per-scenario summaries.

`serveFile` honours `Range: bytes=...` requests and returns `206 Partial Content` (so
Safari's `<audio>` element will play, and seeking works correctly across browsers).
Path traversal is blocked with `safeJoin`; only files under the smoketest data dir are
served.
