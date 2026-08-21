# the-test-web

Backend for **The Test** (Palisade Research) — a Vercel/Next.js app that:

- receives **Typeform** submission webhooks (`POST /api/typeform/webhook`),
- lands every payload **verbatim** in Neon, then derives typed response + answer rows,
- (next) enriches from the **Prolific API** by `SESSION_ID`,
- (next) LLM-scores freeform answers via the **AI Gateway**.

The web page itself is intentionally nearly blank — this is a backend.

## Stack
- Next.js 16 (App Router) + React 19
- Neon Postgres (`@neondatabase/serverless`)
- Deployed on Vercel (Fluid Compute)

## Layout
```
app/
  page.tsx                      nearly-blank status page
  api/health/route.ts           GET health + db ping
  api/typeform/webhook/route.ts POST Typeform webhook ingest
lib/
  db.ts        Neon client (lazy)
  log.ts       structured JSON logging
  typeform.ts  HMAC verify + payload parsing
db/
  schema.sql   raw -> response -> answers (+ prolific_submission)
scripts/
  db-push.mjs  apply schema.sql
```

## Setup
1. `npm install`
2. Copy `.env.example` → `.env.local`, fill `DATABASE_URL` (Neon) and `TYPEFORM_WEBHOOK_SECRET`.
3. Apply schema: `node --env-file=.env.local scripts/db-push.mjs`
4. `npm run dev`

## Data model
Three layers, append-only raw as source of truth. See `../plans/data-model-raw-response.md`.

## Notes
- The Typeform webhook may not include browser `metadata` (user_agent/network_id/…);
  those columns fill in via Responses-API enrichment (TODO).
- Hidden fields must be pre-declared in the Typeform to appear in the payload.
  Pass `prolific_pid`, `study_id`, `session_id` (+ `campaign_id`, `subtest`, `arm`,
  `wave`, `content_variant`) on the embed URL.
