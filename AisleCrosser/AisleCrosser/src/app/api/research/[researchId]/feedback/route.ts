import { NextRequest, NextResponse } from "next/server";
import { submitFeedback } from "@/lib/store/research";
import { feedbackSchema } from "@/lib/utils/validation";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ researchId: string }> }
) {
  const { researchId } = await params;
  const body = await request.json();
  const parsed = feedbackSchema.safeParse({ ...body, researchId });

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid input", details: parsed.error.issues }, { status: 400 });
  }

  const success = await submitFeedback(researchId, parsed.data.targetType, parsed.data.targetId, {
    value: parsed.data.value,
    comment: parsed.data.comment,
    submittedAt: new Date().toISOString(),
  });

  if (!success) {
    return NextResponse.json({ error: "Research or target not found" }, { status: 404 });
  }

  return NextResponse.json({ success: true });
}
