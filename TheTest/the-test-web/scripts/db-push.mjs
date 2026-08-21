// Apply db/schema.sql to the Neon database in DATABASE_URL.
// Run: node --env-file=.env.local scripts/db-push.mjs
import { readFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set (try: node --env-file=.env.local scripts/db-push.mjs)");
  process.exit(1);
}

const sql = neon(url);
const text = await readFile(new URL("../db/schema.sql", import.meta.url), "utf8");

// Strip line comments, split on statement terminators.
const statements = text
  .split("\n")
  .filter((l) => !l.trim().startsWith("--"))
  .join("\n")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

let n = 0;
for (const stmt of statements) {
  await sql.query(stmt);
  n++;
}
console.log(`applied ${n} statements`);
