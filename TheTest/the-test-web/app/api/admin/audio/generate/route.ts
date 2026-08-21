import { getSql } from "@/lib/db";
import { log } from "@/lib/log";
import { requirePalisadeUser } from "@/lib/auth";
import { fetchTypeformResponseData } from "@/lib/typeform";
import { persistVoiceRecording } from "@/lib/voice-store";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const VOICE_FORM_FALLBACK = "FORMID0002";

// Lazy-generate fallback: if a voice answer's recording was never persisted
// (webhook miss), generate it on demand here, then redirect to the canonical
// streaming route. Self-heals gaps — but only works WHILE Typeform still has
// the source (Mux tokens expire in ~weeks), so eager webhook persistence +
// backfill remain the durable path. Idempotent: re-checks before generating.
export async function GET(req: Request) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { searchParams } = new URL(req.url);
  const responseId = searchParams.get("response");
  const fieldRef = searchParams.get("ref");
  if (!responseId || !fieldRef) return new Response("bad request", { status: 400 });

  const sql = getSql();

  // Already persisted? → straight to the streaming route.
  const existing = (await sql`
    select id from voice_recording
    where survey_response_id = ${responseId} and field_ref = ${fieldRef} limit 1
  `) as { id: string }[];
  if (existing[0]) {
    return Response.redirect(new URL(`/api/admin/audio/${existing[0].id}`, req.url), 302);
  }

  // Resolve the Typeform source and persist now.
  const meta = (await sql`
    select sr.typeform_token, raw.typeform_form_id as form_id
    from survey_response sr
    left join survey_response_raw raw on raw.id = sr.raw_id
    where sr.id = ${responseId} limit 1
  `) as { typeform_token: string | null; form_id: string | null }[];
  if (!meta[0]) return new Response("not found", { status: 404 });

  const data = await fetchTypeformResponseData(
    meta[0].form_id ?? VOICE_FORM_FALLBACK,
    meta[0].typeform_token,
  );
  const v = data?.voice.find((x) => x.fieldRef === fieldRef);
  if (!v) return new Response("source unavailable (expired?)", { status: 410 });

  const rec = await persistVoiceRecording(v.audioUrl, { responseId, fieldRef });
  if (!rec) return new Response("generation failed", { status: 502 });

  // ALARM: reaching here means the webhook never persisted this recording, and
  // we only caught it because an admin happened to view it. Other un-viewed
  // responses may have un-persisted audio that will silently expire on Mux. Log
  // loudly + tag the row 'lazy_admin' so `scripts/audit-voice.ts` can surface it.
  log.event({
    kind: "recording.lazy_generated",
    level: "warn",
    data: { response_id: responseId, field_ref: fieldRef, bytes: rec.byteSize },
  });

  const inserted = (await sql`
    insert into voice_recording
      (survey_response_id, field_ref, blob_url, blob_pathname,
       content_type, byte_size, duration_seconds, source)
    values
      (${responseId}, ${fieldRef}, ${rec.blobUrl}, ${rec.blobPathname},
       ${rec.contentType}, ${rec.byteSize}, ${rec.durationSeconds}, 'lazy_admin')
    on conflict (survey_response_id, field_ref) do update set blob_url = excluded.blob_url
    returning id
  `) as { id: string }[];

  return Response.redirect(new URL(`/api/admin/audio/${inserted[0].id}`, req.url), 302);
}
