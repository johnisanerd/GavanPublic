#!/usr/bin/env bun
// PAT: generate-image skill handler. Calls openai/gpt-5.4-image-2 via
// OpenRouter and writes a PNG to /workspace/agent/gen/. Auth is injected
// by the OneCLI gateway — no key handling here.
//
// Invoke:
//   bun /app/skills/generate-image/generate.ts \
//     --prompt "<text>" [--quality medium|high] [--out-dir <path>]
//
// Stdout (on success): the absolute PNG path, single line.
// Stdout (on cache hit): same, plus the line `cache_hit: true` on stderr.
// Stderr: progress + the JSON event lines we POST to /admin/log-event.
// Exit codes: 0 success, 1 bad args, 2 API error, 3 write error.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const MODEL = 'openai/gpt-5.4-image-2';
const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const HOST_LOG_URL = process.env.PAT_LOG_HOST_URL ?? 'http://host.docker.internal:8765/admin/log-event';

type Quality = 'low' | 'medium' | 'high';
const QUALITY_VALUES: readonly Quality[] = ['low', 'medium', 'high'];

interface Args {
  prompt: string;
  quality: Quality;
  outDir: string;
}

function parseArgs(argv: string[]): Args | { error: string } {
  let prompt: string | undefined;
  let quality: Quality = 'medium';
  let outDir = '/workspace/agent/gen';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--prompt') prompt = argv[++i];
    else if (a === '--quality') {
      const q = argv[++i] as Quality;
      if (!QUALITY_VALUES.includes(q)) return { error: `--quality must be low|medium|high (got "${q}")` };
      quality = q;
    } else if (a === '--out-dir') outDir = argv[++i];
    else if (a.startsWith('--')) return { error: `unknown flag: ${a}` };
  }
  if (!prompt || prompt.trim().length === 0) return { error: '--prompt is required' };
  return { prompt, quality, outDir };
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

interface BaseEventFields {
  thread_id?: string | null;
  session_id?: string | null;
}

function readEnvIds(): BaseEventFields {
  return {
    thread_id: process.env.PAT_THREAD_ID ?? null,
    session_id: process.env.PAT_SESSION_ID ?? null,
  };
}

async function postLogEvent(
  kind: string,
  data: Record<string, unknown>,
  level: 'info' | 'error' = 'info',
): Promise<void> {
  const ids = readEnvIds();
  const body = JSON.stringify({
    source: 'agent-runner',
    kind,
    level,
    thread_id: ids.thread_id,
    session_id: ids.session_id,
    data,
  });
  // Mirror to stderr too so a non-host invocation still leaves a trail.
  process.stderr.write(`[log-event] ${body}\n`);
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 2000);
    await fetch(HOST_LOG_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: ac.signal,
    });
    clearTimeout(t);
  } catch (e) {
    // Logging is best-effort — never fail the image gen on a log POST failure.
    process.stderr.write(`[log-event] POST failed (non-fatal): ${String(e)}\n`);
  }
}

interface OpenRouterImage {
  image_url?: { url?: string };
}

interface OpenRouterChoice {
  message?: {
    content?: string;
    images?: OpenRouterImage[];
  };
}

interface OpenRouterResponse {
  choices?: OpenRouterChoice[];
  error?: { message?: string; code?: number | string };
}

function extractPngBase64(resp: OpenRouterResponse): string | null {
  const url = resp.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!url) return null;
  const comma = url.indexOf(',');
  return comma >= 0 ? url.slice(comma + 1) : url;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if ('error' in parsed) {
    process.stderr.write(`generate-image: ${parsed.error}\n`);
    process.exit(1);
  }
  const { prompt, quality, outDir } = parsed;

  const cacheKey = sha256Hex(`${MODEL}|${quality}|${prompt}`);
  const outPath = resolvePath(outDir, `${cacheKey}.png`);

  await postLogEvent('imagegen.requested', {
    prompt,
    quality,
    model: MODEL,
    cache_key: cacheKey,
  });

  // Cache check — same prompt+quality+model = same hash = serve from disk.
  if (existsSync(outPath)) {
    const st = statSync(outPath);
    await postLogEvent('imagegen.completed', {
      cache_key: cacheKey,
      cache_hit: true,
      latency_ms: 0,
      bytes: st.size,
      output_path: outPath,
    });
    process.stderr.write(`cache_hit: true (${st.size} bytes)\n`);
    process.stdout.write(`${outPath}\n`);
    return;
  }

  mkdirSync(outDir, { recursive: true });

  // OpenAI's gpt-image-* family accepts a native `quality: low|medium|high`
  // top-level param (low = fast drafts, medium = default, high = max fidelity).
  // OpenRouter passes /chat/completions params through to the underlying
  // OpenAI image route, so we send it directly — no more prompt-prefix hack.
  const reqBody = {
    model: MODEL,
    modalities: ['image', 'text'],
    quality,
    messages: [{ role: 'user', content: prompt }],
  };

  const t0 = Date.now();
  // PAT: in production (inside the agent container) auth is injected by
  // the OneCLI HTTPS_PROXY — no Authorization header is set here. The
  // env-var fallback below is a dev affordance for running the handler
  // outside the container (local smoke tests). When OPENROUTER_API_KEY
  // is unset (the container case), the header simply isn't added.
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.OPENROUTER_API_KEY) {
    headers['authorization'] = `Bearer ${process.env.OPENROUTER_API_KEY}`;
  }
  let resp: Response;
  try {
    resp = await fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    const msg = `network error: ${String(e)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(2);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    const msg = `HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 500)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(2);
  }

  let parsedResp: OpenRouterResponse;
  try {
    parsedResp = (await resp.json()) as OpenRouterResponse;
  } catch (e) {
    const msg = `bad json: ${String(e)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(2);
  }

  if (parsedResp.error) {
    const msg = `openrouter error: ${parsedResp.error.message ?? JSON.stringify(parsedResp.error)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(2);
  }

  const b64 = extractPngBase64(parsedResp);
  if (!b64) {
    const msg = 'no image in response';
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.stderr.write(`response preview: ${JSON.stringify(parsedResp).slice(0, 500)}\n`);
    process.exit(2);
  }

  let bytes: Buffer;
  try {
    bytes = Buffer.from(b64, 'base64');
  } catch (e) {
    const msg = `base64 decode failed: ${String(e)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(3);
  }

  try {
    writeFileSync(outPath, bytes);
  } catch (e) {
    const msg = `write failed: ${String(e)}`;
    await postLogEvent(
      'imagegen.completed',
      { cache_key: cacheKey, cache_hit: false, latency_ms: Date.now() - t0, error: msg },
      'error',
    );
    process.stderr.write(`generate-image: ${msg}\n`);
    process.exit(3);
  }

  const latency = Date.now() - t0;
  await postLogEvent('imagegen.completed', {
    cache_key: cacheKey,
    cache_hit: false,
    latency_ms: latency,
    bytes: bytes.length,
    output_path: outPath,
  });

  process.stderr.write(`done in ${latency}ms (${bytes.length} bytes) → ${outPath}\n`);
  process.stdout.write(`${outPath}\n`);
}

main().catch((e) => {
  process.stderr.write(`generate-image: unhandled error: ${String(e)}\n`);
  process.exit(2);
});
