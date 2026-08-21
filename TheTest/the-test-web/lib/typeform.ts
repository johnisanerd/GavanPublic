import crypto from "node:crypto";

// ── Forms API (for the admin form picker) ────────────────────────────────────
const TYPEFORM_API = "https://api.typeform.com";

export interface TypeformForm {
  id: string;
  title: string;
  displayUrl: string; // the live form (form.typeform.com/to/<id>)
  editUrl: string; // the Typeform editor (admin.typeform.com/form/<id>/create)
}

// List the account's forms for the picker. One page of 200 covers us; we log if
// there are more rather than silently truncating.
export async function listForms(): Promise<TypeformForm[]> {
  const apiToken = process.env.TYPEFORM_API_TOKEN;
  if (!apiToken) throw new Error("TYPEFORM_API_TOKEN is not set");
  const res = await fetch(`${TYPEFORM_API}/forms?page_size=200`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });
  if (!res.ok) throw new Error(`typeform list forms ${res.status}`);
  const data = await res.json();
  return (data.items ?? []).map(
    (f: { id: string; title: string; _links?: { display?: string } }) => ({
      id: f.id,
      title: f.title,
      displayUrl: f._links?.display ?? `https://form.typeform.com/to/${f.id}`,
      editUrl: `https://admin.typeform.com/form/${f.id}/create`,
    }),
  );
}

// ── Webhook registration ─────────────────────────────────────────────────────
// Our webhook is one tag ("thetest") per form, all pointing at the prod receiver
// and signed with TYPEFORM_WEBHOOK_SECRET. Binding a form auto-registers it so
// nobody has to wire webhooks in Typeform by hand.
//
// The URL is always prod (never the caller's host) — registering a localhost URL
// from dev would silently break ingestion. PUT is create-or-replace and keyed on
// (form, tag), so this is idempotent: re-binding an already-wired form just
// re-asserts the same config. We always send `secret` so a re-register can't drop
// signing (which the receiver requires).
const WEBHOOK_TAG = "thetest";
const WEBHOOK_URL =
  process.env.TYPEFORM_WEBHOOK_URL ?? "https://the-test.org/api/typeform/webhook";

export async function registerFormWebhook(formId: string): Promise<void> {
  const apiToken = process.env.TYPEFORM_API_TOKEN;
  const secret = process.env.TYPEFORM_WEBHOOK_SECRET;
  if (!apiToken) throw new Error("TYPEFORM_API_TOKEN is not set");
  if (!secret) throw new Error("TYPEFORM_WEBHOOK_SECRET is not set");
  const res = await fetch(
    `${TYPEFORM_API}/forms/${formId}/webhooks/${WEBHOOK_TAG}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${apiToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        enabled: true,
        verify_ssl: true,
        secret,
      }),
    },
  );
  if (!res.ok) {
    throw new Error(`typeform register webhook ${res.status}: ${await res.text()}`);
  }
}

// ── Form preparation / import ─────────────────────────────────────────────────
// A bound form must (a) declare the hidden fields our /g/ launch injects and the
// webhook reads for attribution, and (b) redirect on completion to /completed so
// Prolific participants are handed back. A freshly-built Typeform has NEITHER —
// and the only way to add hidden fields + a redirect ending is a whole-form PUT
// (JSON-Patch can't touch /hidden or /thankyou_screens). To avoid ever mutating
// the user's original form, we IMPORT: duplicate it (server reassigns ids), bake
// the prep into the copy, bind to the copy, and rename the original
// "<name> [backup]". The GET→strip-ids→POST round-trip is verified lossless for
// our form shapes (fields/logic/variables/settings all survive).

const REQUIRED_HIDDEN = [
  "prolific_pid", "study_id", "session_id", "channel", "cohort",
  "respondent_ref", "visit_token", "content_variant", "arm", "wave",
];
// Same prod origin as the webhook; {{hidden:...}} are Typeform recall tokens
// substituted per-submission.
const COMPLETED_REDIRECT_URL =
  `${new URL(WEBHOOK_URL).origin}/completed` +
  `?study_id={{hidden:study_id}}&session_id={{hidden:session_id}}` +
  `&cohort={{hidden:cohort}}&channel={{hidden:channel}}` +
  `&prolific_pid={{hidden:prolific_pid}}&visit_token={{hidden:visit_token}}` +
  `&respondent_ref={{hidden:respondent_ref}}`;

function authHeader() {
  const token = process.env.TYPEFORM_API_TOKEN;
  if (!token) throw new Error("TYPEFORM_API_TOKEN is not set");
  return { Authorization: `Bearer ${token}` };
}

export async function getForm(formId: string): Promise<any> {
  const res = await fetch(`${TYPEFORM_API}/forms/${formId}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`typeform get form ${res.status}`);
  return res.json();
}

// Already has our hidden fields AND a /completed redirect?
export function isFormPrepared(form: any): boolean {
  const hidden: string[] = form?.hidden ?? [];
  const hasHidden = REQUIRED_HIDDEN.every((h) => hidden.includes(h));
  const hasRedirect = (form?.thankyou_screens ?? []).some(
    (s: any) => (s?.properties?.redirect_url ?? "").includes("/completed"),
  );
  return hasHidden && hasRedirect;
}

// Recursively drop server-assigned `id` keys (create/import rejects them; the
// user-defined `ref`s are kept so logic/piping still resolve).
function stripIds(o: any): any {
  if (Array.isArray(o)) return o.map(stripIds);
  if (o && typeof o === "object")
    return Object.fromEntries(
      Object.entries(o).filter(([k]) => k !== "id").map(([k, v]) => [k, stripIds(v)]),
    );
  return o;
}

// Duplicate `form` into a NEW prepared form (hidden fields + /completed redirect
// added). Returns the new form's id + title.
export async function importPreparedForm(
  form: any,
): Promise<{ id: string; title: string }> {
  const body = stripIds(JSON.parse(JSON.stringify(form)));
  delete body._links;
  delete body.self;
  body.hidden = Array.from(new Set([...(body.hidden ?? []), ...REQUIRED_HIDDEN]));
  const redirect = {
    ref: crypto.randomUUID(),
    title: COMPLETED_REDIRECT_URL,
    type: "url_redirect",
    properties: { redirect_url: COMPLETED_REDIRECT_URL },
  };
  body.thankyou_screens = [
    redirect,
    ...(body.thankyou_screens ?? []).filter(
      (s: any) => !((s?.properties?.redirect_url ?? "").includes("/completed")),
    ),
  ];
  const res = await fetch(`${TYPEFORM_API}/forms`, {
    method: "POST",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`typeform import form ${res.status}: ${await res.text()}`);
  const made = await res.json();
  return { id: made.id, title: made.title };
}

// Surgical title rename via JSON-Patch (/title is whitelisted — no whole-form PUT).
export async function renameForm(formId: string, title: string): Promise<void> {
  const res = await fetch(`${TYPEFORM_API}/forms/${formId}`, {
    method: "PATCH",
    headers: { ...authHeader(), "content-type": "application/json" },
    body: JSON.stringify([{ op: "replace", path: "/title", value: title }]),
  });
  if (!res.ok) throw new Error(`typeform rename form ${res.status}: ${await res.text()}`);
}

// ── Signature verification ──────────────────────────────────────────────────
// Typeform sends `Typeform-Signature: sha256=<base64>` = HMAC-SHA256(secret, rawBody).
export function verifyTypeformSignature(
  rawBody: string,
  header: string | null,
  secret: string,
): boolean {
  if (!header) return false;
  const expected =
    "sha256=" +
    crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ── Question dedup ──────────────────────────────────────────────────────────
// Forgiving normalization so copy-paste whitespace slips collapse to one item.
export function normalizeQuestion(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

export function questionHash(text: string, fieldType: string | null): string {
  const normalized = normalizeQuestion(text);
  return crypto
    .createHash("sha256")
    .update(normalized + "|" + (fieldType ?? ""), "utf8")
    .digest("hex");
}

// ── Parsing ─────────────────────────────────────────────────────────────────
export interface ParsedAnswer {
  position: number;
  fieldId: string | null;
  fieldRef: string | null;
  fieldType: string | null;
  questionTitle: string | null;
  questionHash: string | null;
  questionNormalized: string | null;
  answerType: string | null;
  answerText: string | null;
  answerNumber: number | null;
  answerBoolean: boolean | null;
  answerChoice: string | null;
  answerChoices: unknown | null;
  audioUrl: string | null;
  rawAnswer: unknown;
  isFreeform: boolean;
}

export interface ParsedResponse {
  eventId: string | null;
  eventType: string | null;
  typeformFormId: string | null;
  typeformToken: string | null;
  landedAt: string | null;
  submittedAt: string | null;
  durationSeconds: number | null;
  typeformScore: number | null;
  channel: string;
  cohortSlug: string | null;
  respondentRef: string | null;
  visitToken: string | null;
  prolificPid: string | null;
  prolificStudyId: string | null;
  prolificSessionId: string | null;
  contentVariant: string | null;
  arm: string | null;
  wave: string | null;
  factors: unknown | null;
  userAgent: string | null;
  platform: string | null;
  browser: string | null;
  networkId: string | null;
  referer: string | null;
  variables: unknown | null;
  hidden: Record<string, unknown>;
  answers: ParsedAnswer[];
}

const FREEFORM_TYPES = new Set(["short_text", "long_text", "multi_format"]);

// Typeform sends "0001-01-01T00:00:00Z" for partial/unsubmitted responses.
// Treat that sentinel (and any pre-2000 garbage) as null.
function tsOrNull(v: unknown): string | null {
  if (typeof v !== "string" || !v) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || ms < Date.parse("2000-01-01T00:00:00Z")) return null;
  return v;
}

function durationSeconds(landed: string | null, submitted: string | null) {
  if (!landed || !submitted) return null;
  const d = Math.round((Date.parse(submitted) - Date.parse(landed)) / 1000);
  // clamp to a sane range so bad timestamps never overflow integer / store junk
  if (!Number.isFinite(d) || d < 0 || d > 2_592_000) return null; // [0, 30 days]
  return d;
}

export function parseFormResponse(payload: any): ParsedResponse {
  const fr = payload?.form_response ?? {};
  const def = fr.definition ?? {};
  const hidden: Record<string, unknown> = fr.hidden ?? {};
  const meta = fr.metadata ?? {};

  const byId = new Map<string, any>();
  const byRef = new Map<string, any>();
  for (const f of def.fields ?? []) {
    if (f?.id) byId.set(f.id, f);
    if (f?.ref) byRef.set(f.ref, f);
  }

  const answers: ParsedAnswer[] = (fr.answers ?? []).map((a: any, position: number) => {
    const fieldId: string | null = a?.field?.id ?? null;
    const fieldRef: string | null = a?.field?.ref ?? null;
    const defField =
      (fieldId && byId.get(fieldId)) || (fieldRef && byRef.get(fieldRef)) || {};
    const fieldType: string | null = defField.type ?? a?.field?.type ?? null;
    const questionTitle: string | null = defField.title ?? null;
    const t: string | null = a?.type ?? null;

    let answerText: string | null = null;
    let answerNumber: number | null = null;
    let answerBoolean: boolean | null = null;
    let answerChoice: string | null = null;
    let answerChoices: unknown | null = null;
    let audioUrl: string | null = null;

    switch (t) {
      case "text":
        answerText = a.text ?? null;
        break;
      case "email":
        answerText = a.email ?? null;
        break;
      case "url":
        answerText = a.url ?? null;
        break;
      case "date":
        answerText = a.date ?? null;
        break;
      case "file_url":
        answerText = a.file_url ?? null;
        break;
      case "phone_number":
        answerText = a.phone_number ?? null;
        break;
      case "number":
        answerNumber = a.number ?? null;
        break;
      case "boolean":
        answerBoolean = a.boolean ?? null;
        break;
      case "choice":
        answerChoice = a.choice?.label ?? a.choice?.other ?? null;
        break;
      case "choices":
        answerChoices = a.choices ?? null;
        break;
      case "multi_format":
        // voice/video answer. Typeform's own transcript is poor and often not
        // ready at webhook time, so we re-transcribe from audio_url with
        // ElevenLabs after ingest; seed with whatever Typeform gives us.
        answerText =
          a.multi_format?.audio_transcript ?? a.multi_format?.video_transcript ?? null;
        audioUrl = a.multi_format?.audio_url ?? null;
        break;
      default:
        break;
    }

    return {
      position,
      fieldId,
      fieldRef,
      fieldType,
      questionTitle,
      questionHash: questionTitle ? questionHash(questionTitle, fieldType) : null,
      questionNormalized: questionTitle ? normalizeQuestion(questionTitle) : null,
      answerType: t,
      answerText,
      answerNumber,
      answerBoolean,
      answerChoice,
      answerChoices,
      audioUrl,
      rawAnswer: a,
      isFreeform: fieldType ? FREEFORM_TYPES.has(fieldType) : false,
    };
  });

  // Unused hidden fields arrive as "" — normalize to null so analysis isn't
  // muddied by empty-string buckets in arm/wave/respondent_ref/etc.
  const str = (v: unknown): string | null => {
    if (v == null) return null;
    const s = String(v).trim();
    return s === "" ? null : s;
  };

  const prolificPid = str(hidden.prolific_pid ?? hidden.PROLIFIC_PID);
  // channel: explicit hidden field wins; else infer from presence of a Prolific id.
  const channel =
    str(hidden.channel) ?? (prolificPid ? "prolific" : "direct");
  const respondentRef =
    prolificPid ?? str(hidden.respondent_ref ?? hidden.r);

  const factors =
    hidden.factors && typeof hidden.factors === "object" ? hidden.factors : null;

  const landedAt = tsOrNull(fr.landed_at);
  const submittedAt = tsOrNull(fr.submitted_at);

  return {
    eventId: payload?.event_id ?? null,
    eventType: payload?.event_type ?? null,
    typeformFormId: fr.form_id ?? def.id ?? null,
    typeformToken: fr.token ?? null,
    landedAt,
    submittedAt,
    durationSeconds: durationSeconds(landedAt, submittedAt),
    typeformScore: fr.calculated?.score ?? null,
    channel,
    cohortSlug: str(hidden.cohort ?? hidden.cohort_id),
    respondentRef,
    visitToken: str(hidden.visit_token ?? hidden.v),
    prolificPid,
    prolificStudyId: str(hidden.study_id ?? hidden.STUDY_ID),
    prolificSessionId: str(hidden.session_id ?? hidden.SESSION_ID),
    contentVariant: str(hidden.content_variant),
    arm: str(hidden.arm),
    wave: str(hidden.wave),
    factors,
    userAgent: str(meta.user_agent),
    platform: str(meta.platform),
    browser: str(meta.browser),
    networkId: str(meta.network_id),
    referer: str(meta.referer),
    variables: fr.variables ?? null,
    hidden,
    answers,
  };
}

// The webhook payload is missing two things that live ONLY in the Responses API:
//   1. browser metadata (user_agent, platform, browser, network_id, referer)
//   2. voice answers' audio_url — the webhook delivers multi_format answers as
//      empty {} objects; audio_url only appears here (on the 2nd delivery).
// One fetch returns both. Best-effort; returns null on any failure.
export async function fetchTypeformResponseData(
  formId: string | null,
  token: string | null,
): Promise<{
  metadata: {
    user_agent: string | null;
    platform: string | null;
    browser: string | null;
    network_id: string | null;
    referer: string | null;
  } | null;
  voice: { fieldRef: string | null; audioUrl: string }[];
} | null> {
  const apiToken = process.env.TYPEFORM_API_TOKEN;
  if (!apiToken || !formId || !token) return null;
  const res = await fetch(
    `https://api.typeform.com/forms/${formId}/responses?included_response_ids=${token}`,
    { headers: { Authorization: `Bearer ${apiToken}` } },
  );
  if (!res.ok) return null;
  const data = await res.json();
  const item = data?.items?.[0];
  if (!item) return null;
  const m = item.metadata;
  const metadata = m
    ? {
        user_agent: m.user_agent ?? null,
        platform: m.platform ?? null,
        browser: m.browser ?? null,
        network_id: m.network_id ?? null,
        referer: m.referer ?? null,
      }
    : null;
  const voice = (item.answers ?? [])
    .filter((a: any) => a?.type === "multi_format" && a?.multi_format?.audio_url)
    .map((a: any) => ({
      fieldRef: a.field?.ref ?? null,
      audioUrl: a.multi_format.audio_url as string,
    }));
  return { metadata, voice };
}
