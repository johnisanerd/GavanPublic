"use server";

interface PreviewRequest {
  toolName: string;
  inputName: string;
  inputType: string;
  simulatorPrompt: string;
  outputName: string;
  outputType: string;
}

interface PreviewResponse {
  hypotheticalInput: string;
  generatedOutput: string;
  narrativeContext: string;
}

// Mock LLM preview for v1 - in production, this would call an actual LLM
export async function generateToolPreview(
  request: PreviewRequest
): Promise<PreviewResponse> {
  // Simulate API delay
  await new Promise((resolve) => setTimeout(resolve, 500));

  // Generate mock hypothetical input based on input type
  const hypotheticalInput = generateMockInput(
    request.inputName,
    request.inputType
  );

  // Replace tokens in simulator prompt (for documentation purposes in v1)
  // In production, this would be passed to the LLM
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let promptWithTokens = request.simulatorPrompt;
  promptWithTokens = promptWithTokens.replace(/\{\{input\}\}/g, hypotheticalInput);
  promptWithTokens = promptWithTokens.replace(/\{\{previous_tool_calls\}\}/g, "[]");
  promptWithTokens = promptWithTokens.replace(
    /\{\{output_tool\}\}/g,
    `return_${request.outputName}`
  );

  // Generate mock output based on output type
  const generatedOutput = generateMockOutput(
    request.outputName,
    request.outputType,
    request.inputType === "string" && request.inputName === "command"
  );

  // Generate mock narrative context
  const narrativeContext = `Tool "${request.toolName}" processed input successfully. The simulator prompt instructed to call {{output_tool}} with the result.`;

  return {
    hypotheticalInput,
    generatedOutput,
    narrativeContext,
  };
}

function generateMockInput(name: string, type: string): string {
  switch (type) {
    case "boolean":
      return "true";
    case "integer":
      return "42";
    case "number":
      return "3.14159";
    case "string":
      if (name.toLowerCase().includes("command")) {
        return "ls -la /tmp";
      }
      return `example ${name} value`;
    case "none":
      return "(no input)";
    default:
      return "example value";
  }
}

function generateMockOutput(
  name: string,
  type: string,
  isCommand: boolean
): string {
  if (isCommand && type === "string") {
    return `total 8
drwxr-xr-x  3 user  wheel   96 Jan 15 10:30 .
drwxr-xr-x  5 user  wheel  160 Jan 15 09:15 ..
-rw-r--r--  1 user  wheel  128 Jan 15 10:30 foo.txt`;
  }

  switch (type) {
    case "boolean":
      return "false";
    case "integer":
      return "7";
    case "number":
      return "2.71828";
    case "string":
      return `processed ${name} result`;
    case "none":
      return "(no output)";
    default:
      return "result value";
  }
}
