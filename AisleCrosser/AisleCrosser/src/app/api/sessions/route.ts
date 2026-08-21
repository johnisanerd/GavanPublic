import { NextRequest, NextResponse } from "next/server";
import { createSession } from "@/lib/store/sessions";
import { createSessionSchema } from "@/lib/utils/validation";
import { generateId } from "@/lib/utils/ids";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = createSessionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
  }

  const session = {
    id: generateId("sess"),
    legislatorId: parsed.data.legislatorId,
    createdAt: new Date().toISOString(),
    lastActiveAt: new Date().toISOString(),
    initiativeIds: [],
    researchIds: [],
  };

  await createSession(session);
  return NextResponse.json(session, { status: 201 });
}
