import { redirect } from "next/navigation";
import { getSql } from "@/lib/db";
import { log } from "@/lib/log";
import { fetchCompletionCode, prolificCompleteUrl } from "@/lib/prolific";

// Post-survey landing. Typeform's "Redirect on completion" sends participants
// here, forwarding their hidden fields via recall tokens (configured once on
// the form — see README.md in this directory). Two paths:
//
//   1. Prolific study  → resolve the study's success completion code from the
//      Prolific API and redirect to app.prolific.com so the submission counts.
//   2. Anything else    → render a branded "thank you" no-op.
//
// NEVER 500: if the Prolific lookup yields nothing we degrade to the thank-you
// page with a "return to Prolific" note rather than failing the participant.

export const dynamic = "force-dynamic";

type SearchParams = Promise<Record<string, string | undefined>>;

// Typeform sends "" for unset hidden fields, AND in the redirect URL it leaves
// recall tokens like "{{hidden:session_id}}" UNSUBSTITUTED when the field is
// unset (e.g. a plain-link visit with no Prolific params). Treat both empty
// strings and unsubstituted tokens as absent — otherwise a direct visitor's
// literal "{{hidden:session_id}}" reads as a real session and wrongly triggers
// the Prolific path.
function clean(v: string | undefined): string | null {
  if (v == null) return null;
  const s = v.trim();
  if (s === "" || s.includes("{{") || s.includes("}}")) return null;
  return s;
}

// Best-effort fallback override stored on the cohort, used only when the live
// Prolific API lookup returns nothing. Never throws.
async function cohortFallbackCode(
  studyId: string | null,
  cohortSlug: string | null,
): Promise<string | null> {
  try {
    const sql = getSql();
    if (studyId) {
      const rows = (await sql`
        select prolific_completion_code from cohort
        where prolific_study_id = ${studyId} limit 1
      `) as { prolific_completion_code: string | null }[];
      if (rows[0]?.prolific_completion_code) return rows[0].prolific_completion_code;
    }
    if (cohortSlug) {
      const rows = (await sql`
        select prolific_completion_code from cohort
        where slug = ${cohortSlug} limit 1
      `) as { prolific_completion_code: string | null }[];
      if (rows[0]?.prolific_completion_code) return rows[0].prolific_completion_code;
    }
  } catch (e) {
    log.event({
      kind: "completion.fallback_failed",
      level: "warn",
      data: { error: String(e) },
    });
  }
  return null;
}

// Mark the matching survey_response as having reached /completed, for drop-off
// analysis (reached-completion vs submitted-webhook). Best-effort, non-blocking.
async function markReached(sessionId: string | null): Promise<void> {
  if (!sessionId) return;
  try {
    const sql = getSql();
    await sql`
      update survey_response
      set hidden = coalesce(hidden, '{}'::jsonb)
        || jsonb_build_object('completed_redirect_at', ${new Date().toISOString()})
      where prolific_session_id = ${sessionId}
    `;
  } catch {
    // swallow — drop-off tracking must never affect the redirect
  }
}

export default async function CompletedPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const studyId = clean(params.study_id);
  const sessionId = clean(params.session_id);
  const cohort = clean(params.cohort);
  const channel = clean(params.channel);
  const prolificPid = clean(params.prolific_pid);

  // Only treat as Prolific when we have a real SESSION_ID — Prolific injects that
  // per submission. channel=prolific / study_id can be stray static params or
  // unsubstituted placeholders on a non-Prolific visit, so don't trust them alone
  // (otherwise the thank-you wrongly tells direct visitors to "return to Prolific").
  const isProlific = Boolean(sessionId);

  log.event({
    kind: "completion.reached",
    prolific_session_id: sessionId ?? undefined,
    data: {
      is_prolific: isProlific,
      study_id: studyId,
      cohort,
      channel,
      has_pid: Boolean(prolificPid),
    },
  });

  // Best-effort drop-off marker — fire and await briefly so it lands before
  // we redirect away (the function may freeze post-redirect on serverless).
  await markReached(sessionId);

  // Completion always sends them back — we do NOT gate on quality here. The
  // verdict can't even exist yet for voice (transcription lags by minutes), and
  // blocking completion is unfair. Rejection happens later, in review, using the
  // is_low_quality / is_ai_likely flags.

  // ── Path 2: non-Prolific → no-op thank-you page ───────────────────────────
  if (!isProlific) {
    return <ThankYou />;
  }

  // ── Path 1: Prolific → resolve completion code, then redirect ─────────────
  let code: string | null = null;
  if (studyId) code = await fetchCompletionCode(studyId);
  if (!code) code = await cohortFallbackCode(studyId, cohort);

  if (code) {
    // redirect() throws NEXT_REDIRECT — must be outside try/catch.
    redirect(prolificCompleteUrl(code));
  }

  // No code resolvable — degrade gracefully rather than 500.
  log.event({
    kind: "completion.no_code",
    level: "warn",
    prolific_session_id: sessionId ?? undefined,
    data: { study_id: studyId, cohort },
  });
  return <ThankYou prolificNote />;
}

// ── Branded thank-you — uses the shared app theme (bg-background etc.) ───────
function ThankYou({ prolificNote = false }: { prolificNote?: boolean }) {
  return (
    <main className="bg-background text-foreground grid min-h-dvh place-items-center p-8 text-center font-mono">
      <div className="max-w-lg">
        <h1 className="text-primary mb-3 text-3xl font-semibold">
          You&rsquo;re all done — thank you.
        </h1>
        <p className="text-base leading-relaxed opacity-80">
          Your responses have been recorded. We appreciate you taking the time.
        </p>
        {prolificNote && (
          <p className="mt-6 text-sm leading-relaxed opacity-70">
            You may now return to Prolific to complete your submission.
          </p>
        )}
      </div>
    </main>
  );
}
