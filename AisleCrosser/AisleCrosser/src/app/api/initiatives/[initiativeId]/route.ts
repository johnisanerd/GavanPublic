import { NextResponse } from "next/server";
import { getInitiative, updateInitiative, deleteInitiative } from "@/lib/store/initiatives";
import { updateInitiativeSchema } from "@/lib/utils/validation";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ initiativeId: string }> }
) {
  const { initiativeId } = await params;
  const initiative = await getInitiative(initiativeId);

  if (!initiative) {
    return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  }

  return NextResponse.json(initiative);
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ initiativeId: string }> }
) {
  const { initiativeId } = await params;
  const body = await request.json();
  const parsed = updateInitiativeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
  }

  const updated = await updateInitiative(initiativeId, parsed.data);
  if (!updated) {
    return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  }

  return NextResponse.json(updated);
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ initiativeId: string }> }
) {
  const { initiativeId } = await params;
  const deleted = await deleteInitiative(initiativeId);

  if (!deleted) {
    return NextResponse.json({ error: "Initiative not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
