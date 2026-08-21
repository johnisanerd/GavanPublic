import { getSql } from "@/lib/db";
import { log } from "@/lib/log";
import { transcribeTypeformAudio } from "@/lib/transcribe";
import { persistVoiceRecording } from "@/lib/voice-store";
import {
  fetchTypeformResponseData,
  parseFormResponse,
  verifyTypeformSignature,
} from "@/lib/typeform";
import { computeAnswerQualities, rollupResponseQualities } from "@/lib/quality";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

// Typeform webhook receiver.
// 1. read raw body (needed for HMAC), 2. verify signature, 3. land raw verbatim,
// 4. resolve cohort, 5. derive typed response + answers (idempotent on token),
// 6. upsert the question bank. Returns 2xx fast once landed.
export async function POST(request: Request) {
  const rawBody = await request.text();
  const sigHeader = request.headers.get("typeform-signature");
  const headers = Object.fromEntries(request.headers);
  const secret = process.env.TYPEFORM_WEBHOOK_SECRET;

  const isSignatureValid = secret
    ? verifyTypeformSignature(rawBody, sigHeader, secret)
    : false;

  if (secret && !isSignatureValid) {
    log.event({ kind: "webhook.rejected", level: "warn", data: { reason: "bad_signature" } });
    return new Response("invalid signature", { status: 401 });
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    log.event({ kind: "webhook.rejected", level: "warn", data: { reason: "bad_json" } });
    return new Response("invalid json", { status: 400 });
  }

  const p = parseFormResponse(payload);
  log.event({
    kind: "webhook.received",
    token: p.typeformToken ?? undefined,
    event_id: p.eventId ?? undefined,
    data: { form_id: p.typeformFormId, channel: p.channel, answers: p.answers.length, isSignatureValid },
  });

  const sql = getSql();

  // ── Layer 1: land raw verbatim (append-only) ──────────────────────────────
  const [raw] = (await sql`
    insert into survey_response_raw
      (source, event_id, event_type, typeform_form_id, typeform_token,
       is_signature_valid, raw_headers, raw_payload)
    values
      ('typeform_webhook', ${p.eventId}, ${p.eventType}, ${p.typeformFormId}, ${p.typeformToken},
       ${isSignatureValid}, ${JSON.stringify(headers)}::jsonb, ${rawBody}::jsonb)
    returning id
  `) as { id: string }[];

  // ── Resolve cohort (by Prolific STUDY_ID, else by cohort slug) ────────────
  let cohortId: string | null = null;
  let experimentId: string | null = null;
  if (p.channel === "prolific" && p.prolificStudyId) {
    const rows = (await sql`
      select id, experiment_id from cohort where prolific_study_id = ${p.prolificStudyId} limit 1
    `) as { id: string; experiment_id: string | null }[];
    if (rows[0]) ({ id: cohortId, experiment_id: experimentId } = rows[0]);
  } else if (p.cohortSlug) {
    const rows = (await sql`
      select id, experiment_id from cohort where slug = ${p.cohortSlug} limit 1
    `) as { id: string; experiment_id: string | null }[];
    if (rows[0]) ({ id: cohortId, experiment_id: experimentId } = rows[0]);
  }

  // Per-answer qualities computed at ingest; response rollups derived from them.
  const answerQualities = p.answers.map((a) =>
    computeAnswerQualities(a.answerText, a.fieldType, a.isFreeform),
  );
  const { is_low_quality, is_ai_likely } = rollupResponseQualities(
    answerQualities.map((qualities) => ({ qualities })),
  );

  // ── Layer 2: typed response (upsert; completed submission wins) ────────────
  // Typeform sends partial + completed under the same token. Update when the
  // incoming is complete (submitted_at present) or the existing row is still
  // partial; never let a stray partial overwrite a completed response.
  const resp = (await sql`
    insert into survey_response (
      raw_id, typeform_token, experiment_id, cohort_id, channel, respondent_ref, visit_token,
      prolific_pid, prolific_study_id, prolific_session_id,
      content_variant, arm, wave, factors,
      landed_at, submitted_at, duration_seconds, typeform_score,
      user_agent, platform, browser, network_id, referer, variables, hidden, is_low_quality, is_ai_likely
    ) values (
      ${raw.id}, ${p.typeformToken}, ${experimentId}, ${cohortId}, ${p.channel}, ${p.respondentRef}, ${p.visitToken},
      ${p.prolificPid}, ${p.prolificStudyId}, ${p.prolificSessionId},
      ${p.contentVariant}, ${p.arm}, ${p.wave}, ${p.factors ? JSON.stringify(p.factors) : null}::jsonb,
      ${p.landedAt}, ${p.submittedAt}, ${p.durationSeconds}, ${p.typeformScore},
      ${p.userAgent}, ${p.platform}, ${p.browser}, ${p.networkId}, ${p.referer},
      ${p.variables ? JSON.stringify(p.variables) : null}::jsonb,
      ${JSON.stringify(p.hidden)}::jsonb, ${is_low_quality}, ${is_ai_likely}
    )
    on conflict (typeform_token) do update set
      raw_id = excluded.raw_id, experiment_id = excluded.experiment_id,
      cohort_id = excluded.cohort_id, channel = excluded.channel,
      respondent_ref = excluded.respondent_ref, visit_token = excluded.visit_token,
      prolific_pid = excluded.prolific_pid, prolific_study_id = excluded.prolific_study_id,
      prolific_session_id = excluded.prolific_session_id, content_variant = excluded.content_variant,
      arm = excluded.arm, wave = excluded.wave, factors = excluded.factors,
      landed_at = excluded.landed_at, submitted_at = excluded.submitted_at,
      duration_seconds = excluded.duration_seconds, typeform_score = excluded.typeform_score,
      user_agent = excluded.user_agent, platform = excluded.platform,
      browser = excluded.browser, network_id = excluded.network_id,
      referer = excluded.referer, variables = excluded.variables, hidden = excluded.hidden,
      is_low_quality = excluded.is_low_quality, is_ai_likely = excluded.is_ai_likely
    where excluded.submitted_at is not null or survey_response.submitted_at is null
    returning id, (xmax = 0) as inserted
  `) as { id: string; inserted: boolean }[];

  // Conflict where the incoming is a partial that must not override a completed row.
  if (!resp[0]) {
    log.event({ kind: "webhook.superseded", token: p.typeformToken ?? undefined, data: {} });
    return Response.json({ ok: true, superseded: true });
  }
  const responseId = resp[0].id;
  const isNew = resp[0].inserted;

  // On update (partial -> complete, or re-delivery) replace the prior answers.
  if (!isNew) {
    await sql`delete from survey_answer where survey_response_id = ${responseId}`;
  }

  // ── Layer 3: answers + question-bank upsert ───────────────────────────────
  for (const [idx, a] of p.answers.entries()) {
    if (a.questionHash && a.questionNormalized && a.questionTitle) {
      // Only count a question once per response (on first creation), so retries
      // and partial->complete updates don't inflate times_seen.
      if (isNew) {
        await sql`
          insert into question (question_hash, normalized_text, sample_text, field_type)
          values (${a.questionHash}, ${a.questionNormalized}, ${a.questionTitle}, ${a.fieldType})
          on conflict (question_hash) do update set times_seen = question.times_seen + 1
        `;
      } else {
        await sql`
          insert into question (question_hash, normalized_text, sample_text, field_type)
          values (${a.questionHash}, ${a.questionNormalized}, ${a.questionTitle}, ${a.fieldType})
          on conflict (question_hash) do nothing
        `;
      }
    }
    await sql`
      insert into survey_answer (
        survey_response_id, position, question_hash, field_id, field_ref, field_type, question_title,
        answer_type, answer_text, answer_number, answer_boolean, answer_choice,
        answer_choices, raw_answer, is_freeform, qualities
      ) values (
        ${responseId}, ${a.position}, ${a.questionHash}, ${a.fieldId}, ${a.fieldRef}, ${a.fieldType}, ${a.questionTitle},
        ${a.answerType}, ${a.answerText}, ${a.answerNumber}, ${a.answerBoolean}, ${a.answerChoice},
        ${a.answerChoices ? JSON.stringify(a.answerChoices) : null}::jsonb,
        ${JSON.stringify(a.rawAnswer)}::jsonb, ${a.isFreeform},
        ${JSON.stringify(answerQualities[idx])}::jsonb
      )
    `;
  }

  // ── Enrich from the Responses API: browser metadata + voice transcription ──
  // The webhook payload lacks both — multi_format answers arrive as empty {} and
  // there's no metadata block. audio_url shows up in the Responses API around the
  // 2nd delivery; poll briefly if it lags. Best-effort — never break ingestion.
  const expectsVoice = p.answers.some((a) => a.fieldType === "multi_format");
  try {
    let data = await fetchTypeformResponseData(p.typeformFormId, p.typeformToken);
    for (let i = 0; expectsVoice && (!data || data.voice.length === 0) && i < 5; i++) {
      await new Promise((r) => setTimeout(r, 4000));
      data = await fetchTypeformResponseData(p.typeformFormId, p.typeformToken);
    }

    if (data?.metadata) {
      const m = data.metadata;
      await sql`
        update survey_response set
          user_agent = ${m.user_agent}, platform = ${m.platform},
          browser = ${m.browser}, network_id = ${m.network_id}, referer = ${m.referer}
        where id = ${responseId}
      `;
    }

    if (data?.voice.length) {
      // Recordings already persisted for this response — skip re-storing them so
      // redeliveries don't create duplicate blobs (idempotent on field_ref).
      const existing = (await sql`
        select field_ref from voice_recording where survey_response_id = ${responseId}
      `) as { field_ref: string }[];
      const persisted = new Set(existing.map((r) => r.field_ref));

      log.event({
        kind: "transcribe.start",
        token: p.typeformToken ?? undefined,
        data: { count: data.voice.length, hasKey: Boolean(process.env.ELEVENLABS_API_KEY) },
      });
      let filled = 0;
      let stored = 0;
      await Promise.all(
        data.voice.map(async (v) => {
          // 1. transcribe → answer_text (+ recompute this voice answer's
          // qualities: its word_count/too_short change with the new transcript;
          // ai_likelihood stays 0 for voice/multi_format).
          const text = await transcribeTypeformAudio(v.audioUrl);
          if (text) {
            filled++;
            const q = computeAnswerQualities(text, "multi_format", true);
            await sql`update survey_answer
              set answer_text = ${text}, qualities = ${JSON.stringify(q)}::jsonb
              where survey_response_id = ${responseId} and field_ref = ${v.fieldRef}`;
          }
          // 2. persist the audio to private Blob (best-effort, skip if stored)
          if (v.fieldRef && !persisted.has(v.fieldRef)) {
            const rec = await persistVoiceRecording(v.audioUrl, {
              responseId,
              fieldRef: v.fieldRef,
            });
            if (rec) {
              stored++;
              await sql`
                insert into voice_recording
                  (survey_response_id, field_ref, blob_url, blob_pathname,
                   content_type, byte_size, duration_seconds, source)
                values
                  (${responseId}, ${v.fieldRef}, ${rec.blobUrl}, ${rec.blobPathname},
                   ${rec.contentType}, ${rec.byteSize}, ${rec.durationSeconds}, 'webhook')
                on conflict (survey_response_id, field_ref) do nothing
              `;
            }
          }
        }),
      );
      // Recompute the response rollups from ALL freeform answers' (now-updated)
      // qualities blobs.
      const ff = (await sql`
        select qualities from survey_answer
        where survey_response_id = ${responseId} and is_freeform
      `) as { qualities: Record<string, unknown> }[];
      const rollup = rollupResponseQualities(ff);
      await sql`update survey_response
        set is_low_quality = ${rollup.is_low_quality}, is_ai_likely = ${rollup.is_ai_likely}
        where id = ${responseId}`;
      log.event({
        kind: "transcribe.done",
        token: p.typeformToken ?? undefined,
        data: { count: data.voice.length, filled, stored },
      });
    }
  } catch (e) {
    log.event({
      kind: "enrich.failed",
      level: "warn",
      token: p.typeformToken ?? undefined,
      data: { error: String(e) },
    });
  }

  log.event({
    kind: "webhook.ingested",
    token: p.typeformToken ?? undefined,
    prolific_session_id: p.prolificSessionId ?? undefined,
    data: { response_id: responseId, channel: p.channel, answers: p.answers.length },
  });

  return Response.json({ ok: true, response_id: responseId });
}
