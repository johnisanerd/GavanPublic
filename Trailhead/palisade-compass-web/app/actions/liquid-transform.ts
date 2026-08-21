"use server";

import { Liquid } from "liquidjs";

const liquid = new Liquid();

// Register custom 'prompt' filter for Liquid
liquid.registerFilter("prompt", (input: string, promptText: string) => {
  // This is a pass-through v1 implementation
  // In the future, this could actually call an LLM
  return `[prompt: "${promptText}" applied to: ${input}]`;
});

interface TransformContext {
  last_response?: string;
  previous_tool_calls?: Array<{
    tool: string;
    input: unknown;
    output: unknown;
    narrative?: string;
  }>;
  [key: string]: unknown;
}

export async function transformLiquidTemplate(
  template: string,
  context: TransformContext
): Promise<{ success: true; result: string } | { success: false; error: string }> {
  try {
    const result = await liquid.parseAndRender(template, context);
    return {
      success: true,
      result,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}
