"use server";

import { generateExperimentCreationPrompt } from "@/lib/experiment-prompt-generator";

export async function getExperimentCreationPrompt(): Promise<string> {
  return generateExperimentCreationPrompt();
}
