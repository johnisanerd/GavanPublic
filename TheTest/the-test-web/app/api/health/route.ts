import { getSql } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  let db = "unconfigured";
  try {
    if (process.env.DATABASE_URL) {
      const sql = getSql();
      await sql`select 1`;
      db = "ok";
    }
  } catch {
    db = "error";
  }
  return Response.json({ ok: true, db, ts: new Date().toISOString() });
}
