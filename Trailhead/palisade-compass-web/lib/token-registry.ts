export interface TokenExample {
  label: string;
  value: string;
  description: string;
  type: "variable" | "function";
  includeInSteps?: boolean;
  includeInTools?: boolean;
}

export const TOKEN_EXAMPLE_REGISTRY: TokenExample[] = [
  {
    label: "Last Response",
    value: "{{ last_response }}",
    description: "Insert the last LLM response",
    type: "variable",
    includeInSteps: true,
    includeInTools: false,
  },
  {
    label: "Transform Last Response",
    value: '{{ last_response | prompt: "Create an argument against this claim" }}',
    description: "Transform last response with a prompt",
    type: "variable",
    includeInSteps: true,
    includeInTools: false,
  },
  {
    label: "Previous Tool Calls",
    value: "{{ previous_tool_calls }}",
    description: "Insert array of previous tool calls",
    type: "variable",
    includeInSteps: true,
    includeInTools: true,
  },
  {
    label: "Last Call to a Tool",
    value: '{% assign last_call = previous_tool_calls | where: "name", "tool_name" | last %}{{ last_call.output }}',
    description: "Get output from last call to a specific tool",
    type: "variable",
    includeInSteps: true,
    includeInTools: true,
  },
  {
    label: "Step Number",
    value: "{{ step_number }}",
    description: "Current step number in the sequence",
    type: "variable",
    includeInSteps: true,
    includeInTools: true,
  },
  {
    label: "Clear History",
    value: "{{ clear_history }}",
    description: "Clear conversation history before this step",
    type: "function",
    includeInSteps: true,
    includeInTools: false,
  },
  {
    label: "Input",
    value: "{{input}}",
    description: "Current input value",
    type: "variable",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Output Tool",
    value: "{{output_tool}}",
    description: "Identifier of the output tool",
    type: "function",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Tool Call Count",
    value: "{{tool_call_count}}",
    description: "Total number of tool calls made so far",
    type: "variable",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Update Score",
    value: "{{update_score}}",
    description: "Update the experiment score",
    type: "function",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Score",
    value: "{{score}}",
    description: "Current experiment score value",
    type: "variable",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Tool Notes",
    value: "{{tool_notes}}",
    description: "All accumulated tool notes (filter by tool name if needed)",
    type: "variable",
    includeInSteps: false,
    includeInTools: true,
  },
  {
    label: "Record Tool Note",
    value: "{{record_tool_note}}",
    description: "Append a note to the tool notes history (auto-includes tool name property)",
    type: "function",
    includeInSteps: false,
    includeInTools: true,
  },
];

export function getTokenExamplesForSteps(): TokenExample[] {
  return TOKEN_EXAMPLE_REGISTRY.filter((token) => token.includeInSteps);
}

export function getTokenExamplesForTools(): TokenExample[] {
  return TOKEN_EXAMPLE_REGISTRY.filter((token) => token.includeInTools);
}
