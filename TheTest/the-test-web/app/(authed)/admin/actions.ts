"use server";

import { headers } from "next/headers";

import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";
import {
  listForms as tfListForms,
  registerFormWebhook,
  getForm,
  isFormPrepared,
  importPreparedForm,
  renameForm,
  type TypeformForm,
} from "@/lib/typeform";
import { createDraftStudy } from "@/lib/prolific";

// Admin mutations as React 19 Server Functions (the `"use server"` directive).
// These are callable directly from client components as typed async functions —
// no route handler, no `fetch`, no hand-typed JSON response. This is the
// canonical pattern for admin writes; survey-binding mutations follow it.
//
// SECURITY (read the Next docs' bold warning): a Server Function is reachable by
// a direct POST, exactly like a route handler — it is NOT protected just because
// the UI gates it. So every action must do its OWN auth + validation. There is
// no structural gate; forgetting `requirePalisadeUser()` here is a real hole.
//
// On reads: our admin lists are React-Query polling, not RSC, so `revalidatePath`
// does nothing for us — the client invalidates its own query cache after the
// mutation resolves. We therefore call these as React Query `mutationFn`s.

export type ExperimentRow = { id: string; slug: string; name: string };

// Rename an experiment. Slug is immutable (the admin-cohorts query key is keyed
// by slug, so it must survive a rename). More experiment fields can follow the
// same shape.
export async function renameExperiment(
  slug: string,
  name: string,
): Promise<ExperimentRow> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");

  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");

  const sql = getSql();
  const [row] = (await sql`
    update experiment set name = ${trimmed} where slug = ${slug}
    returning id, slug, name
  `) as ExperimentRow[];
  if (!row) throw new Error("experiment not found");

  return row;
}

// --- Survey (Typeform) binding ---------------------------------------------

const slugify = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// List the account's Typeform forms for the picker. Gated like every action.
export async function listForms(): Promise<TypeformForm[]> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");
  return tfListForms();
}

// Ensure the form we bind is "prepared" — it declares our hidden fields and
// redirects on completion to /completed (without these, /g/ launches lose cohort
// attribution and Prolific participants aren't handed back).
//
// IDEMPOTENT: if the picked form is ALREADY prepared (detected by isFormPrepared
// — has the hidden fields + /completed redirect), we bind it directly, with NO
// re-import and NO second backup. If it's a raw form, we IMPORT it (duplicate +
// prep — never mutating the original), archive the original as "<name> [backup]",
// and bind to the copy. Returns the form id to actually bind + register.
async function ensurePreparedForm(formId: string): Promise<string> {
  const form = await getForm(formId);
  let boundId = formId;
  if (!isFormPrepared(form)) {
    const copy = await importPreparedForm(form);
    boundId = copy.id;
    const base = String(form.title ?? "Form").replace(/\s*\[backup\]\s*$/i, "");
    await renameForm(formId, `${base} [backup]`);
  }
  await registerFormWebhook(boundId);
  return boundId;
}

// Create an experiment bound to a survey form. Both are required by the UI; the
// DB column is nullable (future "configure-after" path), so we enforce here.
// The form is prepared/imported (hidden fields + completion redirect) on bind.
export async function createExperiment(
  name: string,
  formId: string,
): Promise<ExperimentRow> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");

  const trimmed = name.trim();
  if (!trimmed) throw new Error("name required");
  if (!formId) throw new Error("form required");

  const sql = getSql();
  const base = slugify(trimmed) || "experiment";
  let slug = base;
  for (let i = 1; i < 50; i++) {
    const taken = (await sql`select 1 from experiment where slug = ${slug} limit 1`) as unknown[];
    if (!taken.length) break;
    slug = `${base}-${i + 1}`;
  }

  const boundFormId = await ensurePreparedForm(formId);

  const [row] = (await sql`
    insert into experiment (slug, name, typeform_form_id)
    values (${slug}, ${trimmed}, ${boundFormId})
    returning id, slug, name
  `) as ExperimentRow[];
  return row;
}

// Change which form an experiment is bound to. Re-registers the webhook on the
// new form. Existing cohorts keep their stamped form (set at creation) — only
// future cohorts inherit this new binding.
export async function bindExperimentForm(
  slug: string,
  formId: string,
): Promise<ExperimentRow> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");
  if (!formId) throw new Error("form required");

  const boundFormId = await ensurePreparedForm(formId);

  const sql = getSql();
  const [row] = (await sql`
    update experiment set typeform_form_id = ${boundFormId} where slug = ${slug}
    returning id, slug, name
  `) as ExperimentRow[];
  if (!row) throw new Error("experiment not found");
  return row;
}

// PERMANENTLY delete an experiment and everything under it. Destructive + not
// undoable, so the caller must pass the exact experiment name (the UI makes the
// user type it). Deletes children-first, since only survey_answer/scored_answer/
// voice_recording cascade off survey_response — cohorts, launch_events and the
// response→experiment/cohort FKs do not. (prolific_submission is keyed by
// session id with no FK, so it's left as-is.)
export async function deleteExperiment(
  slug: string,
  confirmName: string,
): Promise<{ ok: true }> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");

  const sql = getSql();
  const [exp] = (await sql`
    select id, name from experiment where slug = ${slug} limit 1
  `) as { id: string; name: string }[];
  if (!exp) throw new Error("experiment not found");
  if (confirmName.trim() !== exp.name) throw new Error("name does not match");

  const id = exp.id;
  // launch_event → cohort (no cascade): clear before cohorts/responses.
  await sql`delete from launch_event where cohort_id in (select id from cohort where experiment_id = ${id})`;
  // Capture raw payload ids before the responses (which reference them) go.
  const raws = (await sql`
    select raw_id from survey_response
    where experiment_id = ${id} and raw_id is not null
  `) as { raw_id: string }[];
  // Responses (cascades survey_answer/scored_answer/voice_recording).
  await sql`delete from survey_response where experiment_id = ${id}`;
  const rawIds = raws.map((r) => r.raw_id);
  if (rawIds.length)
    await sql`delete from survey_response_raw where id = any(${rawIds}::uuid[])`;
  await sql`delete from cohort where experiment_id = ${id}`;
  await sql`delete from experiment where id = ${id}`;

  return { ok: true };
}

// --- Cohort creation -------------------------------------------------------

// Two innocuous words -> human-friendly slug + short link (e.g. /g/amber-otter).
const ADJ = [
  "amber", "violet", "copper", "silent", "rapid", "golden", "crimson", "azure",
  "misty", "brisk", "lunar", "solar", "velvet", "quiet", "swift", "noble",
  "frosty", "ember", "hidden", "jolly", "dusky", "mellow", "cobalt", "ivory",
  "russet", "teal", "wandering", "gentle", "stout", "clever",
];
const NOUN = [
  "otter", "finch", "badger", "cedar", "heron", "willow", "falcon", "marten",
  "sparrow", "maple", "raven", "lynx", "bison", "wren", "poplar", "sable",
  "ferret", "crane", "vireo", "elk", "thistle", "hazel", "robin", "birch",
  "marmot", "plover", "juniper", "stoat", "alder", "pika",
];
const pick = (a: string[]) => a[Math.floor(Math.random() * a.length)];
const titleCase = (s: string) =>
  s.split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ");

// Opaque /g/ short code — ALWAYS exactly 8 base36 chars (the old
// Math.random().toString(36).slice() could yield 6–8, hence inconsistent widths).
const CODE_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";
const genShortCode = (len = 8) =>
  Array.from(
    { length: len },
    () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)],
  ).join("");

export type CohortRow = {
  id: string;
  slug: string;
  name: string;
  short_code: string;
};
export type CreateCohortResult = {
  cohort: CohortRow;
  short_link: string;
  has_form: boolean;
};

// Shared cohort minting: gate, require a bound form, generate a unique two-word
// slug + 8-char short_code, stamp the experiment's form, insert with the given
// channel. Returns the row + the absolute /g/ origin. Server Functions have no
// request object, so origin comes from the forwarded host header (Vercel sets
// x-forwarded-proto=https; local dev is http).
async function mintCohort(
  experimentId: string,
  channel: "direct" | "prolific",
): Promise<{ cohort: CohortRow; origin: string }> {
  if (!experimentId) throw new Error("experiment_id required");
  const sql = getSql();

  const [exp] = (await sql`
    select id, typeform_form_id from experiment where id = ${experimentId} limit 1
  `) as { id: string; typeform_form_id: string | null }[];
  if (!exp) throw new Error("experiment not found");
  // A cohort's /g/ link is useless without a form; the experiment must be bound
  // first (the UI gates this too). The form is STAMPED here, so changing the
  // experiment's binding later won't retroactively move this cohort.
  if (!exp.typeform_form_id) throw new Error("experiment has no survey form bound");

  // Two-word label is backend-only (human-readable name/slug).
  let slug = "";
  for (let i = 0; i < 12; i++) {
    const candidate = `${pick(ADJ)}-${pick(NOUN)}`;
    const taken = (await sql`select 1 from cohort where slug = ${candidate} limit 1`) as unknown[];
    if (!taken.length) {
      slug = candidate;
      break;
    }
  }
  if (!slug) slug = `${pick(ADJ)}-${pick(NOUN)}-${Math.floor(Math.random() * 1000)}`;

  // Opaque, fixed-length (8) short_code for the public /g/ link.
  let shortCode = genShortCode();
  for (let i = 0; i < 12; i++) {
    const taken = (await sql`select 1 from cohort where short_code = ${shortCode} limit 1`) as unknown[];
    if (!taken.length) break;
    shortCode = genShortCode();
  }

  const [cohort] = (await sql`
    insert into cohort (experiment_id, slug, name, channel, short_code, typeform_form_id)
    values (${exp.id}, ${slug}, ${titleCase(slug)}, ${channel}, ${shortCode},
            ${exp.typeform_form_id})
    returning id, slug, name, short_code
  `) as CohortRow[];

  const h = await headers();
  const host = h.get("host");
  const proto = h.get("x-forwarded-proto") ?? "http";
  return { cohort, origin: `${proto}://${host}` };
}

// "Run" path 1 — a shareable /g/ link (direct channel).
export async function createCohort(
  experimentId: string,
): Promise<CreateCohortResult> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");

  const { cohort, origin } = await mintCohort(experimentId, "direct");
  return {
    cohort,
    short_link: `${origin}/g/${cohort.short_code}`,
    has_form: true,
  };
}

export type ProlificRunParams = {
  name: string;
  places: number;
  rewardCents: number;
  minutes: number;
  requireMicrophone: boolean;
};
export type ProlificRunResult = {
  cohort: CohortRow;
  short_link: string;
  studyUrl: string; // researcher-facing Prolific draft URL (review + publish)
};

// "Run" path 2 — create an UNPUBLISHED Prolific draft pointed at a new prolific
// cohort's /g/ link. Recruits no one and charges nothing; the researcher reviews
// and publishes it in Prolific (the money step). Prolific substitutes the
// {{%...%}} placeholders, which /g/ forwards into Typeform's hidden fields.
export async function createProlificRun(
  experimentId: string,
  params: ProlificRunParams,
): Promise<ProlificRunResult> {
  const viewer = await requirePalisadeUser();
  if (!viewer) throw new Error("forbidden");

  const name = params.name.trim();
  if (!name) throw new Error("study name required");
  if (!params.places || params.places < 1) throw new Error("places must be ≥ 1");
  if (params.rewardCents < 0) throw new Error("reward must be ≥ 0");
  if (!params.minutes || params.minutes < 1) throw new Error("time must be ≥ 1 min");

  const { cohort, origin } = await mintCohort(experimentId, "prolific");
  const shortLink = `${origin}/g/${cohort.short_code}`;
  const externalStudyUrl =
    `${shortLink}?prolific_pid={{%PROLIFIC_PID%}}` +
    `&study_id={{%STUDY_ID%}}&session_id={{%SESSION_ID%}}`;

  try {
    const study = await createDraftStudy({
      name,
      description:
        "A short research survey. Please answer thoughtfully; some questions " +
        "ask you to think out loud.",
      externalStudyUrl,
      totalAvailablePlaces: params.places,
      estimatedCompletionTime: params.minutes,
      rewardCents: params.rewardCents,
      requireMicrophone: params.requireMicrophone,
    });

    const sql = getSql();
    await sql`update cohort set prolific_study_id = ${study.id} where id = ${cohort.id}`;

    return { cohort, short_link: shortLink, studyUrl: study.url };
  } catch (e) {
    // The cohort exists but the draft failed — surface it; the orphan cohort is
    // harmless (a direct /g/ link still works) and visible in the table.
    throw new Error(
      `Cohort created, but the Prolific draft failed: ${String(e instanceof Error ? e.message : e)}`,
    );
  }
}
