-- The Test — schema v1
-- Principle: store everything verbatim (raw_*), derive typed views.
-- Hierarchy: experiment -> cohort (channel: prolific|direct) -> responses.
-- Naming: is_<bool>, <verb>_at, one name per concept, raw_* for verbatim blobs.
--
-- DESTRUCTIVE: drops and recreates all tables. Safe pre-launch (no real data).
-- Apply with: node --env-file=.env.local scripts/db-push.mjs

create extension if not exists "pgcrypto";

drop table if exists voice_recording     cascade;
drop table if exists scored_answer       cascade;
drop table if exists survey_answer        cascade;
drop table if exists survey_response       cascade;
drop table if exists survey_response_raw   cascade;
drop table if exists prolific_submission   cascade;
drop table if exists launch_event          cascade;
drop table if exists question              cascade;
drop table if exists cohort                cascade;
drop table if exists experiment            cascade;
-- legacy v0 tables
drop table if exists subtest               cascade;
drop table if exists campaign              cascade;

-- ───────────────────────────────────────────────────────────────────────────
-- Experiment / cohort scaffolding
-- ───────────────────────────────────────────────────────────────────────────
create table experiment (
  id            uuid primary key default gen_random_uuid(),
  slug          text unique not null,
  name          text not null,
  description   text,
  typeform_form_id text,                                  -- the experiment's CURRENT survey binding (changeable). New cohorts stamp this into their own typeform_form_id at creation; nullable in DB but required by the create-experiment UI.
  created_at    timestamptz not null default now()
);

-- A cohort is one batch of people recruited one way. Prolific is one channel.
create table cohort (
  id                 uuid primary key default gen_random_uuid(),
  experiment_id      uuid references experiment(id),
  slug               text not null,
  name               text not null,
  channel            text not null default 'direct',  -- 'prolific' | 'direct'
  short_code         text unique,                       -- /g/<short_code> launch link (per cohort)
  typeform_form_id   text,                              -- form /g/ redirects to; STAMPED from experiment.typeform_form_id at cohort creation, then immutable (so changing the experiment's binding only affects future cohorts)
  prolific_study_id  text,                              -- Prolific STUDY_ID (channel=prolific)
  prolific_completion_code text,                         -- optional manual override for /completed redirect (else resolved live from Prolific API)
  config             jsonb,
  wave               text,                              -- default wave for this cohort (nullable)
  created_at         timestamptz not null default now(),
  unique (experiment_id, slug)
);
create index idx_cohort_prolific_study on cohort (prolific_study_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Question item-bank — auto-populated, deduped by content hash
-- hash = sha256( normalized_text || '|' || field_type ); normalize = trim +
-- collapse internal whitespace + lowercase. Forgiving of copy-paste slips.
-- ───────────────────────────────────────────────────────────────────────────
create table question (
  question_hash    text primary key,
  normalized_text  text not null,
  sample_text      text not null,        -- original text as first seen
  field_type       text,
  first_seen_at    timestamptz not null default now(),
  times_seen       integer not null default 1
);

-- ───────────────────────────────────────────────────────────────────────────
-- Launch redirect events (first-party /g/<cohort> hop). Reserved; endpoint TBD.
-- ───────────────────────────────────────────────────────────────────────────
create table launch_event (
  id             uuid primary key default gen_random_uuid(),
  visit_token    text unique not null,
  cohort_id      uuid references cohort(id),
  channel        text,
  respondent_ref text,
  query          jsonb,
  ip             text,
  user_agent     text,
  referer        text,
  created_at     timestamptz not null default now()
);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 1: raw landing — append-only, verbatim source of truth
-- ───────────────────────────────────────────────────────────────────────────
create table survey_response_raw (
  id                  uuid primary key default gen_random_uuid(),
  received_at         timestamptz not null default now(),
  source              text not null,            -- 'typeform_webhook' | 'responses_api'
  event_id            text,                     -- Typeform event id (idempotency)
  event_type          text,
  typeform_form_id    text,
  typeform_token      text,                     -- Typeform submission id
  is_signature_valid  boolean,
  raw_headers         jsonb,                    -- request headers verbatim
  raw_payload         jsonb not null            -- entire body verbatim
);
create index idx_raw_token   on survey_response_raw (typeform_token);
create index idx_raw_eventid on survey_response_raw (event_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 2: typed response — one row per submission
-- ───────────────────────────────────────────────────────────────────────────
create table survey_response (
  id                   uuid primary key default gen_random_uuid(),
  raw_id               uuid references survey_response_raw(id),
  typeform_token       text unique not null,        -- dedupe key
  experiment_id        uuid references experiment(id),
  cohort_id            uuid references cohort(id),
  channel              text,                          -- 'prolific' | 'direct'
  respondent_ref       text,                          -- channel-agnostic person key
  visit_token          text,                          -- joins launch_event
  prolific_pid         text,
  prolific_study_id    text,
  prolific_session_id  text,
  content_variant      text,
  arm                  text,                          -- treatment / control (nullable)
  wave                 text,                          -- pre / post / single (nullable)
  factors              jsonb,                         -- arbitrary extra A/B dimensions
  landed_at            timestamptz,
  submitted_at         timestamptz,
  duration_seconds     integer,
  typeform_score       numeric,
  user_agent           text,
  platform             text,
  browser              text,
  network_id           text,                          -- Typeform fingerprint
  referer              text,
  variables            jsonb,
  hidden               jsonb,
  is_prolific_enriched boolean not null default false,
  is_scored            boolean not null default false,
  -- Derived rollups of the response's answers' survey_answer.qualities:
  is_low_quality       boolean not null default false,   -- any freeform answer too_short OR ai_likelihood >= 1 (yellow "Low Quality" pill)
  is_ai_likely         boolean not null default false,   -- any freeform answer ai_likelihood >= 1 ("AI?" badge)
  created_at           timestamptz not null default now()
);
create index idx_resp_respondent on survey_response (respondent_ref);
create index idx_resp_pid         on survey_response (prolific_pid);
create index idx_resp_session     on survey_response (prolific_session_id);
create index idx_resp_cohort      on survey_response (cohort_id);
create index idx_resp_experiment  on survey_response (experiment_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Layer 3: answers — one row per question per submission
-- ───────────────────────────────────────────────────────────────────────────
create table survey_answer (
  id                  uuid primary key default gen_random_uuid(),
  survey_response_id  uuid not null references survey_response(id) on delete cascade,
  position            integer,         -- order within the submission (form order)
  question_hash       text references question(question_hash),  -- bank link (nullable)
  field_id            text,
  field_ref           text,
  field_type          text,
  question_title      text,
  answer_type         text,
  answer_text         text,
  answer_number       numeric,
  answer_boolean      boolean,
  answer_choice       text,
  answer_choices      jsonb,
  raw_answer          jsonb,
  is_freeform         boolean not null default false,
  is_scored           boolean not null default false,
  qualities           jsonb not null default '{}'  -- derived per-answer attributes (freeform only): {word_count, too_short, ai_likelihood}; open to future keys
);
create index idx_answer_response on survey_answer (survey_response_id);
create index idx_answer_question on survey_answer (question_hash);
create index idx_answer_ref      on survey_answer (field_ref);

-- ───────────────────────────────────────────────────────────────────────────
-- Per-answer AI scoring — versioned, rerunnable (one row per scoring run)
-- ───────────────────────────────────────────────────────────────────────────
create table scored_answer (
  id                uuid primary key default gen_random_uuid(),
  survey_answer_id  uuid not null references survey_answer(id) on delete cascade,
  scorer_model      text not null,
  rubric_version    text,
  score             numeric,
  label             text,
  rationale         text,
  confidence        numeric,
  flags             jsonb,
  created_at        timestamptz not null default now()
);
create index idx_scored_answer on scored_answer (survey_answer_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Voice recordings — persisted audio for voice answers (Vercel Blob, private)
-- Keyed on (response, field_ref) — STABLE across the webhook's answer churn
-- (survey_answer rows are deleted+recreated on partial→complete redelivery, so
-- survey_answer.id is not a safe foreign key here). blob_url points at a PRIVATE
-- Vercel Blob (requires BLOB_READ_WRITE_TOKEN to read); served via the
-- Clerk-gated /api/admin/audio proxy, never exposed to the browser directly.
-- ───────────────────────────────────────────────────────────────────────────
create table voice_recording (
  id                  uuid primary key default gen_random_uuid(),
  survey_response_id  uuid not null references survey_response(id) on delete cascade,
  field_ref           text not null,
  blob_url            text not null,     -- private blob URL (needs token to read)
  blob_pathname       text,              -- pathname within the store (for del())
  content_type        text not null default 'audio/aac',
  byte_size           integer,
  duration_seconds    integer,
  source              text not null default 'typeform_mux',  -- provenance
  created_at          timestamptz not null default now(),
  unique (survey_response_id, field_ref)
);
create index idx_voice_recording_response on voice_recording (survey_response_id);

-- ───────────────────────────────────────────────────────────────────────────
-- Prolific enrichment — pulled by SESSION_ID, separate job
-- ───────────────────────────────────────────────────────────────────────────
create table prolific_submission (
  prolific_session_id  text primary key,
  prolific_pid         text,
  prolific_study_id    text,
  status               text,            -- approved / returned / timed-out / ...
  started_at           timestamptz,
  completed_at         timestamptz,
  time_taken_seconds   integer,
  reward               numeric,
  demographics         jsonb,
  raw_payload          jsonb,
  fetched_at           timestamptz not null default now()
);
create index idx_prolific_pid on prolific_submission (prolific_pid);

-- ───────────────────────────────────────────────────────────────────────────
-- Completeness view — responses with both enrichment + scoring done
-- ───────────────────────────────────────────────────────────────────────────
create view survey_response_complete as
  select * from survey_response
  where is_prolific_enriched and is_scored;
