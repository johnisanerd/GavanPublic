import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    env: {
      e2b: !!process.env.E2B_API_KEY,
      anthropic: !!process.env.ANTHROPIC_API_KEY,
      congress: !!process.env.CONGRESS_API_KEY,
      apify: !!process.env.APIFY_API_KEY,
    },
  });
}
