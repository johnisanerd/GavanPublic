// One-off: persist voice recordings for existing responses that predate the
// webhook persistence (or that slipped through). Uses the SAME prod modules so
// this doubles as an end-to-end validation. Mux source tokens expire in ~weeks,
// so run this while the Typeform recordings are still resolvable.
//
//   npx tsx scripts/backfill-voice.ts
//
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";
import { fetchTypeformResponseData } from "../lib/typeform";
import { persistVoiceRecording } from "../lib/voice-store";

// Load .env.local into process.env so the prod modules find their tokens.
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  if (!line.includes("=") || line.trim().startsWith("#")) continue;
  const i = line.indexOf("=");
  const k = line.slice(0, i).trim();
  const v = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  if (!(k in process.env)) process.env[k] = v;
}

const VOICE_FORM_FALLBACK = "FORMID0002";
const sql = neon(process.env.DATABASE_URL!);

// Responses that have voice answers with at least one not-yet-persisted clip.
const targets = (await sql`
  select sr.id as response_id, sr.typeform_token, raw.typeform_form_id as form_id,
         count(*) as n_voice
  from survey_answer sa
  join survey_response sr on sr.id = sa.survey_response_id
  left join survey_response_raw raw on raw.id = sr.raw_id
  where sa.field_type = 'multi_format'
    and sa.field_ref is not null
    and not exists (
      select 1 from voice_recording vr
      where vr.survey_response_id = sr.id and vr.field_ref = sa.field_ref
    )
  group by sr.id, sr.typeform_token, raw.typeform_form_id
  order by sr.id
`) as {
  response_id: string;
  typeform_token: string | null;
  form_id: string | null;
  n_voice: string;
}[];

console.log(`responses needing backfill: ${targets.length}`);
let stored = 0;
let skipped = 0;
let failed = 0;

for (const t of targets) {
  const formId = t.form_id ?? VOICE_FORM_FALLBACK;
  const data = await fetchTypeformResponseData(formId, t.typeform_token);
  if (!data || !data.voice.length) {
    console.log(`  ${t.response_id.slice(0, 8)}  no audio_url resolvable (expired?) — skip`);
    skipped += Number(t.n_voice);
    continue;
  }

  // Which clips already exist (idempotent re-runs).
  const existing = (await sql`
    select field_ref from voice_recording where survey_response_id = ${t.response_id}
  `) as { field_ref: string }[];
  const have = new Set(existing.map((r) => r.field_ref));

  for (const v of data.voice) {
    if (!v.fieldRef || have.has(v.fieldRef)) continue;
    const rec = await persistVoiceRecording(v.audioUrl, {
      responseId: t.response_id,
      fieldRef: v.fieldRef,
    });
    if (!rec) {
      console.log(`  ${t.response_id.slice(0, 8)}  ${v.fieldRef}  FAILED`);
      failed++;
      continue;
    }
    await sql`
      insert into voice_recording
        (survey_response_id, field_ref, blob_url, blob_pathname,
         content_type, byte_size, duration_seconds, source)
      values
        (${t.response_id}, ${v.fieldRef}, ${rec.blobUrl}, ${rec.blobPathname},
         ${rec.contentType}, ${rec.byteSize}, ${rec.durationSeconds}, 'backfill')
      on conflict (survey_response_id, field_ref) do nothing
    `;
    stored++;
    console.log(
      `  ${t.response_id.slice(0, 8)}  ${v.fieldRef}  ok  ${(rec.byteSize / 1024).toFixed(0)}KB  ${rec.durationSeconds ?? "?"}s`,
    );
  }
}

console.log(`\nbackfill done: stored=${stored} skipped=${skipped} failed=${failed}`);
