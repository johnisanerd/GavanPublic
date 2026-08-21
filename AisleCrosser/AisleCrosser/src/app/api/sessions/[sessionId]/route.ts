import { NextResponse } from "next/server";
import { getSession, updateSession } from "@/lib/store/sessions";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const session = await getSession(sessionId);

  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(session);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params;
  const body = await request.json();
  const updated = await updateSession(sessionId, {
    ...body,
    lastActiveAt: new Date().toISOString(),
  });

  if (!updated) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  return NextResponse.json(updated);
}
