---
name: generate-image
description: Generate a PNG image from a text prompt using OpenAI's gpt-5.4-image-2 via OpenRouter. Use when the user asks for an image, illustration, diagram, infographic, mockup, or any visual artifact. Returns a tempfile path you then ship with send_file.
allowed-tools: Bash(bun:*)
---

# /generate-image — Image generation (gpt-5.4-image-2 via OpenRouter)

You produce a single PNG from a text prompt. The skill handles the OpenRouter call, the base64 → PNG decode, the on-disk SHA cache, and structured logging. You handle the prompt, the quality dial, the pre-warn message, and the recipient handoff via `send_file`.

## When to use this

Whenever the user wants an image: photos, illustrations, diagrams, infographics, UI mockups, charts, logos, scene compositions. Pick this over describing the image in words.

## Latency reality (read first)

**The `quality` dial controls both fidelity AND speed.** It's the native OpenAI `gpt-image-*` quality knob (low / medium / high), not a prompt-prefix trick. Rough latency on `gpt-5.4-image-2`:

| quality | Typical latency | When |
|---|---|---|
| `low` | ~10–25s | Fast drafts, thumbnails, quick iterations, real-time-channel one-shots |
| `medium` (default) | ~1–2 min | Photos, illustrations, the everyday default |
| `high` | ~2–4 min | Diagrams, infographics, posters — anything with text or fine detail |

When in doubt, start with `low` and re-run at higher quality if the output isn't good enough. `low` is the right pick for the vast majority of casual requests.

## Quality dial — pick for fidelity vs. speed tradeoff

| quality | When to pick it |
|---|---|
| `low` | User wants something fast. Drafts, casual visuals, iteration. ~10–25s. |
| `medium` (default) | Photos, illustrations, single-subject scenes, anything without fine text. ~1–2 min. |
| `high` | Output needs **readable text** or has **multiple distinct elements** the user will inspect closely (diagrams, infographics, posters). ~2–4 min. |

Pick `high` only when you really need the fidelity — most things look great at `low`/`medium` and the user won't be waiting minutes.

## The pre-warn protocol — for `medium` / `high` on real-time channels

On any channel where the user is waiting in real time (voice call, live chat), if you're calling `medium` or `high` you MUST send a short pre-warn message **before** invoking the generate handler. Skip this and they sit in silence for a minute or more wondering if you crashed.

**`low` is fast enough that you can usually skip the pre-warn** — if the user is asking for a quick image and you're going with `low`, just generate and ship; ~20s of silence is fine on a voice call. For `medium`/`high`, always pre-warn on real-time channels.

**Real-time channels** = voice, live chat, anything where the user is actively expecting back-and-forth. **Async channels** = email-style threads, channel posts where they're not watching, an agent-to-agent message queue. On async channels you can skip the pre-warn — by the time they check, the image is already there.

If you're unsure whether the channel is real-time, pre-warn. Cost: one extra short message. Benefit: not stranding the user in silence.

**Step 1 — pre-warn (real-time channels, `medium`/`high` only):**

```
send_message(text: "Generating that — about a minute.")          # medium
send_message(text: "Generating on high quality — a few minutes.")  # high
```

Vary the wording (don't repeat verbatim across sessions) but keep it short and acknowledge the wait. Send this FIRST. Do not chain it after the generate call — by then it's too late. For `low`, skip this step.

**Step 2 — generate (always):**

```bash
bun /app/skills/generate-image/generate.ts --prompt "<your prompt>" --quality low
# or medium (default) / high:
bun /app/skills/generate-image/generate.ts --prompt "<your prompt>" --quality medium
bun /app/skills/generate-image/generate.ts --prompt "<your prompt>" --quality high
```

The handler prints the absolute PNG path on stdout (one line) and exits 0 on success.

**Step 3 — ship the file (always):**

```
send_file(path: "<absolute path from stdout>", text: "<one-line caption>")
```

Captions are optional but help — describe what's in the image, not the process ("Here's a futuristic city skyline at dusk").

## Prompt-writing tips

- **Be specific about subject + style + composition.** "A cat" gets a generic cat; "A grey tabby curled on a sunlit windowsill, soft watercolour style, top-down composition" gets something usable.
- **For diagrams, name the elements.** "Architecture diagram showing a Postgres database, a Redis cache, and a Node API, with arrows labelled 'reads/writes'."
- **Don't include negative prompts** ("no people", "without text") — gpt-5.4-image-2 ignores them. Describe what you want instead.
- **Keep prompts under ~1000 chars.** Longer prompts get truncated by the model.

## Cache behaviour

The skill SHA-hashes `model | quality | prompt` and re-serves from `/workspace/agent/gen/<sha>.png` if the same triple has been requested before. **A cache hit returns in milliseconds and skips the API call entirely** — but you can't know in advance whether it will hit, so on real-time channels still pre-warn. If the cache hit makes the pre-warn look silly, send a quick follow-up ("Actually had it cached — here it is").

## Output

- File path on stdout — one line, absolute, e.g. `/workspace/agent/gen/a3f8...png`
- Diagnostics on stderr (latency, byte count, `cache_hit: true` when applicable)
- Exit 0 on success; non-zero on failure (the stderr message describes what went wrong)

## Failure modes

| Failure | What you'll see | What to do |
|---|---|---|
| Network / OpenRouter 5xx | `generate-image: HTTP 5xx ...` on stderr, exit 2 | Try once more. If it fails again, tell the user briefly and pick a different approach. |
| Content-policy refusal | OpenRouter returns an error string in `parsedResp.error` | Rewrite the prompt to be less ambiguous. Tell the user you adjusted phrasing. |
| `no image in response` | The model returned text but no `images[]` | Re-prompt — usually means the model interpreted the request as a text task. Add "Generate an image of …" to the front. |

## Examples

**Quick draft, low, real-time channel (skip pre-warn):**

```bash
bun /app/skills/generate-image/generate.ts --prompt "A red panda holding a steaming mug of cocoa, cozy cabin interior, soft warm lighting" --quality low
# stdout → /workspace/agent/gen/<sha>.png (back in ~20s)
```
Then: `send_file(path: "<path>", text: "One red panda, very cozy.")`

**Photo, medium (default), real-time channel:**

```
send_message(text: "On it — generating that red panda. About a minute.")
```
```bash
bun /app/skills/generate-image/generate.ts --prompt "A red panda holding a steaming mug of cocoa, cozy cabin interior, soft warm lighting, photorealistic" --quality medium
```

Then: `send_file(path: "<path>", text: "One red panda, very cozy.")`

**Infographic, high, real-time channel:**

```
send_message(text: "Generating that infographic on high — a few minutes.")
```
```bash
bun /app/skills/generate-image/generate.ts \
  --prompt "Infographic showing the water cycle: evaporation from ocean, condensation into clouds, precipitation onto mountains, runoff back to ocean. Label each stage in clear sans-serif. Pastel palette." \
  --quality high
```
Then: `send_file(path: "<path>", text: "Here's the water-cycle infographic.")`

**Async channel (email thread, agent-to-agent queue):**

Skip the pre-warn. Just generate and send the file:

```bash
bun /app/skills/generate-image/generate.ts --prompt "A pixel-art map of a fantasy archipelago, hand-drawn vibe"
```
Then: `send_file(path: "<path>", text: "Here's the map you asked for.")`

## Internal — what's happening under the hood

You don't have to know any of this to use the skill, but: auth to OpenRouter is injected by the OneCLI gateway (no key in the code). The handler POSTs `model:"openai/gpt-5.4-image-2"`, `modalities:["image","text"]`, and the top-level `quality` param to `https://openrouter.ai/api/v1/chat/completions`. OpenRouter forwards `quality` through to the underlying OpenAI image route. Result: the base64 PNG comes back in `choices[0].message.images[0].image_url.url`, gets written to `/workspace/agent/gen/<sha>.png`, and the handler emits `imagegen.requested` + `imagegen.completed` structured log events to the host. Source: `nanoclaw/container/skills/generate-image/generate.ts`.
