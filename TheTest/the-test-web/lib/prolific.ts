import { log } from "@/lib/log";

// Prolific API helpers. Best-effort: every function degrades to null on any
// failure so the /completed flow NEVER 500s. Note Prolific auth uses the
// "Token <key>" scheme (NOT "Bearer").

const PROLIFIC_API = "https://api.prolific.com/api/v1";

// A study's completion_codes look like:
//   [{ code: "EXAMPLECODE", code_type: "COMPLETED",
//      actions: [{ action: "AUTOMATICALLY_APPROVE" }], actor: "participant" }]
// We want the code that represents a successful COMPLETED submission so the
// participant's submission is auto-approved on Prolific.
interface CompletionCode {
  code?: string;
  code_type?: string;
  actions?: { action?: string }[];
  actor?: string;
}

function pickCompletionCode(codes: CompletionCode[]): string | null {
  if (!Array.isArray(codes) || codes.length === 0) return null;

  // 1. Prefer an explicit COMPLETED code type.
  const completed = codes.find(
    (c) => (c.code_type ?? "").toUpperCase() === "COMPLETED" && c.code,
  );
  if (completed?.code) return completed.code;

  // 2. Else a code that auto-approves the submission (also a success path).
  const approve = codes.find(
    (c) =>
      c.code &&
      (c.actions ?? []).some((a) =>
        (a.action ?? "").toUpperCase().includes("APPROVE"),
      ),
  );
  if (approve?.code) return approve.code;

  // 3. Ambiguous — fall back to the first code with a value.
  return codes.find((c) => c.code)?.code ?? null;
}

// Resolve a study's success completion code dynamically. Returns null if the
// token is missing, the lookup fails, or the study has no usable codes.
export async function fetchCompletionCode(
  studyId: string,
): Promise<string | null> {
  const token = process.env.PROLIFIC_API_TOKEN;
  if (!token || !studyId) return null;

  try {
    const res = await fetch(`${PROLIFIC_API}/studies/${studyId}/`, {
      headers: { Authorization: `Token ${token}` },
      // Don't let a slow Prolific API hang the participant's redirect.
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      log.event({
        kind: "prolific.lookup_failed",
        level: "warn",
        data: { study_id: studyId, status: res.status },
      });
      return null;
    }
    const study = (await res.json()) as { completion_codes?: CompletionCode[] };
    const code = pickCompletionCode(study.completion_codes ?? []);
    if (!code) {
      log.event({
        kind: "prolific.lookup_failed",
        level: "warn",
        data: { study_id: studyId, reason: "no_completion_code" },
      });
    }
    return code;
  } catch (e) {
    log.event({
      kind: "prolific.lookup_failed",
      level: "warn",
      data: { study_id: studyId, error: String(e) },
    });
    return null;
  }
}

// The participant-facing URL that tells Prolific the submission is complete.
export function prolificCompleteUrl(code: string): string {
  return `https://app.prolific.com/submissions/complete?cc=${encodeURIComponent(code)}`;
}

// ── Draft study creation ─────────────────────────────────────────────────────
// Create an UNPUBLISHED (draft) study. This recruits NO ONE and charges NOTHING
// — publishing (a separate, money-gated step the researcher does in Prolific) is
// what spends. So this is safe to call unattended. The researcher reviews the
// draft (eligibility, completion code, reward) and publishes it themselves.

const CODE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function genCompletionCode(len = 8): string {
  let s = "";
  for (let i = 0; i < len; i++)
    s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return s;
}

export interface DraftStudyParams {
  name: string;
  description: string;
  externalStudyUrl: string; // /g/<code> with {{%PROLIFIC_PID%}} etc. placeholders
  totalAvailablePlaces: number;
  estimatedCompletionTime: number; // minutes
  rewardCents: number; // in the account's currency
  requireMicrophone?: boolean; // voice surveys
}

// Returns the new study id + the researcher-facing URL to review/publish it.
export async function createDraftStudy(
  p: DraftStudyParams,
): Promise<{ id: string; url: string }> {
  const token = process.env.PROLIFIC_API_TOKEN;
  if (!token) throw new Error("PROLIFIC_API_TOKEN is not set");

  const body: Record<string, unknown> = {
    name: p.name,
    description: p.description,
    external_study_url: p.externalStudyUrl,
    prolific_id_option: "url_parameters", // Prolific injects PID via the URL
    total_available_places: p.totalAvailablePlaces,
    estimated_completion_time: p.estimatedCompletionTime,
    reward: p.rewardCents,
    device_compatibility: ["desktop"],
    // A success code so the round-trip works on publish; our /completed flow
    // resolves it live from the study (fetchCompletionCode), so we don't hardcode
    // it anywhere else. Researcher can change it in Prolific before publishing.
    completion_codes: [
      {
        code: genCompletionCode(),
        code_type: "COMPLETED",
        actions: [{ action: "AUTOMATICALLY_APPROVE" }],
      },
    ],
  };
  if (p.requireMicrophone) body.peripheral_requirements = ["microphone"];

  const res = await fetch(`${PROLIFIC_API}/studies/`, {
    method: "POST",
    headers: {
      Authorization: `Token ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`prolific create study ${res.status}: ${await res.text()}`);
  }
  const study = (await res.json()) as { id: string };
  return {
    id: study.id,
    url: `https://app.prolific.com/researcher/studies/${study.id}`,
  };
}

// Delete a draft study (only works while UNPUBLISHED). Used for test cleanup.
export async function deleteDraftStudy(id: string): Promise<boolean> {
  const token = process.env.PROLIFIC_API_TOKEN;
  if (!token || !id) return false;
  const res = await fetch(`${PROLIFIC_API}/studies/${id}/`, {
    method: "DELETE",
    headers: { Authorization: `Token ${token}` },
  });
  return res.ok;
}
