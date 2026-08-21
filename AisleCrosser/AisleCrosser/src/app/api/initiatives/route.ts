import { NextRequest, NextResponse } from "next/server";
import { createInitiative, listInitiativesByLegislator } from "@/lib/store/initiatives";
import { createInitiativeSchema } from "@/lib/utils/validation";
import { generateId } from "@/lib/utils/ids";

export async function GET(request: NextRequest) {
  const legislatorId = request.nextUrl.searchParams.get("legislatorId");
  if (!legislatorId) {
    return NextResponse.json({ error: "legislatorId query param required" }, { status: 400 });
  }

  const initiatives = await listInitiativesByLegislator(legislatorId);
  return NextResponse.json({ initiatives, count: initiatives.length });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const parsed = createInitiativeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
  }

  const now = new Date().toISOString();
  const initiative = {
    id: generateId("init"),
    ...parsed.data,
    status: "active" as const,
    createdAt: now,
    updatedAt: now,
  };

  await createInitiative(initiative);
  return NextResponse.json(initiative, { status: 201 });
}
