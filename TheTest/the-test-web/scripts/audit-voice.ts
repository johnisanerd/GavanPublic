// Voice-recording integrity audit. Answers two questions data loss depends on:
//   1. Provenance — how many recordings came from each path
//      (webhook = healthy eager grab; lazy_admin = webhook MISSED, only rescued
//       because someone viewed it; backfill = retroactively grabbed).
//   2. At-risk — complete voice answers with NO recording row at all. These are
//      the real danger: their Mux source expires in ~weeks and nobody may ever
//      view them to trigger lazy-gen. Run `scripts/backfill-voice.ts` to rescue.
//
//   npx tsx scripts/audit-voice.ts
//
import { readFileSync } from "node:fs";
import { neon } from "@neondatabase/serverless";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  if (!line.includes("=") || line.trim().startsWith("#")) continue;
  const i = line.indexOf("=");
  process.env[line.slice(0, i).trim()] ??= line
    .slice(i + 1)
    .trim()
    .replace(/^["']|["']$/g, "");
}
const sql = neon(process.env.DATABASE_URL!);

console.log("=== recordings by provenance ===");
const bySource = (await sql`
  select source, count(*)::int n, sum(byte_size)::bigint bytes
  from voice_recording group by source order by n desc
`) as { source: string; n: number; bytes: string }[];
for (const r of bySource) {
  const flag = r.source === "lazy_admin" ? "  ⚠️  webhook missed these" : "";
  console.log(`  ${r.source.padEnd(12)} ${String(r.n).padStart(4)}  ${(Number(r.bytes) / 1024 / 1024).toFixed(1)} MB${flag}`);
}

console.log("\n=== AT-RISK: complete voice answers with no persisted recording ===");
const atRisk = (await sql`
  select sr.id as response_id, c.slug as cohort, sr.submitted_at,
         count(*)::int n_missing
  from survey_answer sa
  join survey_response sr on sr.id = sa.survey_response_id
  left join cohort c on c.id = sr.cohort_id
  where sa.field_type = 'multi_format'
    and sa.field_ref is not null
    and sr.submitted_at is not null
    and not exists (
      select 1 from voice_recording vr
      where vr.survey_response_id = sr.id and vr.field_ref = sa.field_ref
    )
  group by sr.id, c.slug, sr.submitted_at
  order by sr.submitted_at
`) as { response_id: string; cohort: string | null; submitted_at: string; n_missing: number }[];

if (!atRisk.length) {
  console.log("  none — every complete voice answer has a persisted recording ✓");
} else {
  for (const r of atRisk) {
    console.log(`  ${r.response_id.slice(0, 8)}  ${r.cohort ?? "—"}  ${r.submitted_at}  missing ${r.n_missing} clip(s)`);
  }
  console.log(`\n  → ${atRisk.length} response(s) at risk. Run scripts/backfill-voice.ts NOW (Mux tokens expire).`);
}
