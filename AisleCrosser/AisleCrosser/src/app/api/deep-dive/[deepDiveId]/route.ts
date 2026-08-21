import { NextResponse } from "next/server";
import * as deepDiveStore from "@/lib/store/deep-dives";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ deepDiveId: string }> }
) {
  const { deepDiveId } = await params;
  const dive = await deepDiveStore.getDeepDive(deepDiveId);

  if (!dive) {
    return NextResponse.json({ error: "Deep dive not found" }, { status: 404 });
  }

  return NextResponse.json(dive);
}
