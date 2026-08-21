import crypto from "node:crypto";
import { getSql } from "@/lib/db";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

// Launch redirect: /g/<short_code>
// Resolve cohort by short_code, log a launch_event (click capture), mint a
// visit_token, then 302 into the cohort's Typeform with hidden fields populated.
// No login. respondent_ref comes from ?r= (personalized email links); absent =
// anonymous (QR). arm/wave/content_variant pass through if present on the link.
const TYPEFORM_BASE = "https://form.typeform.com/to";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ code: string }> },
) {
  const { code } = await params;
  const url = new URL(request.url);
  const sql = getSql();

  // The cohort stamps its form at creation; fall back to the experiment's
  // current binding as a guard (e.g. a cohort minted before this was set).
  const rows = (await sql`
    select c.id, c.slug, c.channel,
           coalesce(c.typeform_form_id, e.typeform_form_id) as typeform_form_id,
           c.wave
    from cohort c
    left join experiment e on e.id = c.experiment_id
    where c.short_code = ${code} limit 1
  `) as {
    id: string;
    slug: string;
    channel: string;
    typeform_form_id: string | null;
    wave: string | null;
  }[];

  const cohort = rows[0];
  if (!cohort) {
    log.event({ kind: "launch.unknown", level: "warn", data: { code } });
    return new Response("Unknown link.", { status: 404 });
  }
  if (!cohort.typeform_form_id) {
    log.event({ kind: "launch.misconfigured", level: "error", data: { code, cohort: cohort.slug } });
    return new Response("This link is not configured yet.", { status: 500 });
  }

  const visitToken = crypto.randomUUID();
  // Prolific substitutes these into the study's external_study_url; forward them
  // into Typeform's hidden fields so the response is attributed + /completed can
  // resolve the study. respondent_ref comes from ?r= (personalized email links)
  // or, for a Prolific study, the participant id.
  // Treat Prolific's unsubstituted placeholders ("{{%...%}}", on a non-Prolific
  // visit) as absent.
  const sub = (v: string | null) => (v && !v.includes("{{") ? v : null);
  const prolificPid = sub(url.searchParams.get("prolific_pid"));
  const prolificStudyId = sub(url.searchParams.get("study_id"));
  const prolificSessionId = sub(url.searchParams.get("session_id"));
  const respondentRef = url.searchParams.get("r") ?? prolificPid;
  const ip =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip");
  const userAgent = request.headers.get("user-agent");
  const referer = request.headers.get("referer");

  await sql`
    insert into launch_event
      (visit_token, cohort_id, channel, respondent_ref, query, ip, user_agent, referer)
    values
      (${visitToken}, ${cohort.id}, ${cohort.channel}, ${respondentRef},
       ${JSON.stringify(Object.fromEntries(url.searchParams))}::jsonb,
       ${ip}, ${userAgent}, ${referer})
  `;

  // Build the Typeform URL with hidden fields.
  const out = new URLSearchParams();
  out.set("channel", cohort.channel);
  out.set("cohort", cohort.slug);
  out.set("visit_token", visitToken);
  if (respondentRef) out.set("respondent_ref", respondentRef);
  // Prolific identifiers (only present on a Prolific launch).
  if (prolificPid) out.set("prolific_pid", prolificPid);
  if (prolificStudyId) out.set("study_id", prolificStudyId);
  if (prolificSessionId) out.set("session_id", prolificSessionId);
  for (const k of ["arm", "wave", "content_variant"]) {
    const v = url.searchParams.get(k);
    if (v) out.set(k, v);
  }
  if (!out.has("wave") && cohort.wave) out.set("wave", cohort.wave);

  const target = `${TYPEFORM_BASE}/${cohort.typeform_form_id}?${out.toString()}`;
  log.event({
    kind: "launch.redirected",
    data: { code, cohort: cohort.slug, channel: cohort.channel, visit_token: visitToken },
  });

  return Response.redirect(target, 302);
}
