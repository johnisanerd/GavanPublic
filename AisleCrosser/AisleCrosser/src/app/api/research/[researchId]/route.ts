import { NextResponse } from "next/server";
import { getResearch } from "@/lib/store/research";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ researchId: string }> }
) {
  const { researchId } = await params;
  const research = await getResearch(researchId);

  if (!research) {
    return NextResponse.json({ error: "Research not found" }, { status: 404 });
  }

  return NextResponse.json(research);
}
