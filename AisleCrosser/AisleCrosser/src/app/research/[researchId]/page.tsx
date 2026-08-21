"use client";

import { use } from "react";
import { ResearchView } from "@/components/research/research-view";

export default function ResearchPage({ params }: { params: Promise<{ researchId: string }> }) {
  const { researchId } = use(params);
  return <ResearchView researchId={researchId} />;
}
