import { getSql } from "@/lib/db";
import { requirePalisadeUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

// Clerk-gated audio proxy. The recording lives in a PRIVATE Vercel Blob (only
// readable with BLOB_READ_WRITE_TOKEN), so we never hand the blob URL to the
// browser — we fetch it server-side and stream it back under this same-origin,
// cookie-authed route. Because auth rides the Clerk session cookie, an admin can
// click a link to this URL anywhere in their logged-in browser (e.g. shared in
// Slack) and it just plays. Range requests are forwarded so scrubbing works.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ clipId: string }> },
) {
  const viewer = await requirePalisadeUser();
  if (!viewer) return new Response("forbidden", { status: 403 });

  const { clipId } = await params;
  const sql = getSql();
  const rows = (await sql`
    select blob_url, content_type from voice_recording where id = ${clipId} limit 1
  `) as { blob_url: string; content_type: string | null }[];
  if (!rows[0]) return new Response("not found", { status: 404 });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return new Response("blob not configured", { status: 500 });

  // Forward the Range header so the browser's audio scrubber works.
  const range = _req.headers.get("range");
  const upstream = await fetch(rows[0].blob_url, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...(range ? { Range: range } : {}),
    },
  });
  if (!upstream.ok && upstream.status !== 206) {
    return new Response("upstream error", { status: 502 });
  }

  const headers = new Headers();
  headers.set("Content-Type", rows[0].content_type ?? "audio/aac");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  for (const h of ["Content-Length", "Content-Range"]) {
    const v = upstream.headers.get(h);
    if (v) headers.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
