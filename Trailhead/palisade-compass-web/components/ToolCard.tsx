"use client";

import { useState, useRef, useEffect } from "react";
import { ChevronDown, ChevronUp, Trash2, Eye } from "lucide-react";
import { UseFormReturn } from "react-hook-form";
import { CompassExperiment } from "@/lib/types/compass-experiment";
import TokenChips from "./TokenChips";
import { getTokenExamplesForTools } from "@/lib/token-registry";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ToolCardProps {
  index: number;
  form: UseFormReturn<CompassExperiment>;
  onDelete: (index: number) => void;
  onPreview: (index: number) => void;
  totalTools: number;
}

const TYPE_OPTIONS = [
  { value: "boolean", label: "Boolean" },
  { value: "integer", label: "Integer" },
  { value: "number", label: "Number" },
  { value: "string", label: "String" },
  { value: "none", label: "None" },
];

const WHEN_OPTIONS = [
  { value: "optional_every", label: "Every Step (Optional)" },
  { value: "mandatory_every", label: "Every Step (Mandatory)" },
  { value: "mandatory_last", label: "Last Step Only (Mandatory)" },
];

export default function ToolCard({
  index,
  form,
  onDelete,
  onPreview,
  totalTools,
}: ToolCardProps) {
  // Use a key-based approach to persist collapse state across tab changes
  const [isCollapsed, setIsCollapsed] = useState(index !== totalTools - 1);

  // Restore collapse state from sessionStorage after hydration
  useEffect(() => {
    const key = `tool-${index}-collapsed`;
    const stored = sessionStorage.getItem(key);
    if (stored !== null) {
      setIsCollapsed(stored === "true");
    }
  }, [index]);

  const handleToggleCollapse = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    sessionStorage.setItem(`tool-${index}-collapsed`, String(newState));
  };
  const { register, watch } = form;
  const simulatorPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const { ref: registerRef, ...registerRest } = register(
    `tools.${index}.simulatorPrompt` as const
  );

  const toolName = watch(`tools.${index}.name`);

  const handleTokenInsert = (value: string) => {
    const textarea = simulatorPromptRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = textarea.value;

    const newValue =
      currentValue.substring(0, start) + value + currentValue.substring(end);

    form.setValue(`tools.${index}.simulatorPrompt` as const, newValue);

    // Set cursor position after inserted token
    setTimeout(() => {
      textarea.focus();
      const newPosition = start + value.length;
      textarea.setSelectionRange(newPosition, newPosition);
    }, 0);
  };

  const inputName = watch(`tools.${index}.input.name`) || "input";
  const inputType = watch(`tools.${index}.input.type`) || "string";
  const outputType = watch(`tools.${index}.output.type`) || "string";
  const when = watch(`tools.${index}.when`) || "optional_every";

  // Generate function signature
  const signature = `${toolName || "tool"}(${inputName}: ${inputType}) => ${outputType}`;

  // When display mapping
  const getWhenDisplay = () => {
    switch (when) {
      case "mandatory_last":
        return { text: "last", required: true };
      case "mandatory_every":
        return { text: "every", required: true };
      case "optional_every":
      default:
        return { text: "every", required: false };
    }
  };

  const whenDisplay = getWhenDisplay();

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow transition-shadow">
      <div
        className="flex items-center gap-3 border-b border-gray-100 bg-gray-50 px-4 py-3 cursor-pointer hover:bg-gray-100"
        onClick={handleToggleCollapse}
      >
        <code className="flex-1 text-sm font-mono text-blue-600 select-none truncate">
          {signature}
        </code>

        <div className="flex items-center font-mono text-xs text-gray-400 select-none">
          {whenDisplay.required && (
            <span className="text-blue-500">*</span>
          )}
          <span>{whenDisplay.text}</span>
        </div>

        <TooltipProvider>
          <div className="flex items-center gap-1">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(index);
                  }}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Delete tool</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleToggleCollapse();
                  }}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  {isCollapsed ? (
                    <ChevronDown className="h-4 w-4" />
                  ) : (
                    <ChevronUp className="h-4 w-4" />
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{isCollapsed ? "Expand tool" : "Collapse tool"}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      {!isCollapsed && (
        <div className="p-4 space-y-8">
          {/* Header Section: Name, Scope, Description */}
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="block text-sm font-medium text-gray-700 select-none">
                  Name <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  {...register(`tools.${index}.name` as const, {
                    required: true,
                  })}
                  className="mt-2 block w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  placeholder="Tool name"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700">
                  When
                </label>
                <select
                  {...register(`tools.${index}.when` as const)}
                  className="mt-2 block w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                >
                  {WHEN_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700">
                Description <span className="text-red-500">*</span>
              </label>
              <p className="mt-1 text-xs text-gray-500">
                Describe what this tool does so the LLM knows how to use it
              </p>
              <textarea
                {...register(`tools.${index}.description` as const, {
                  required: true,
                })}
                rows={2}
                className="mt-2 block w-full rounded-lg border border-gray-200 px-3.5 py-2.5 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                placeholder="Describe what this tool does"
              />
            </div>
          </div>

          {/* I/O Flow Section */}
          <div className="space-y-4">
            {/* Input */}
            <div className="pt-4">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Input</h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    {...register(`tools.${index}.input.name` as const, {
                      required: true,
                    })}
                    className="mt-1.5 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    placeholder="e.g., command"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600">
                    Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register(`tools.${index}.input.type` as const, {
                      required: true,
                    })}
                    className="mt-1.5 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  >
                    {TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {/* Flow Arrow */}
            <div className="flex items-center justify-center -my-2">
              <div className="flex flex-col items-center">
                <div className="h-4 border-l-2 border-dotted border-gray-300"></div>
                <div className="text-gray-400">↓</div>
              </div>
            </div>

            {/* Tool Simulator Prompt */}
            <div>
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Tool Simulator Prompt</h3>
              </div>
              <div className="mb-2">
                <TokenChips
                  tokens={getTokenExamplesForTools()}
                  onInsert={handleTokenInsert}
                  collapsible={true}
                />
              </div>
              <textarea
                {...registerRest}
                ref={(e) => {
                  registerRef(e);
                  simulatorPromptRef.current = e;
                }}
                rows={6}
                className="block w-full rounded-lg border border-gray-200 px-3.5 py-2.5 font-mono text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                placeholder="Process {{input}} as if it were a Unix command..."
              />
            </div>

            {/* Flow Arrow */}
            <div className="flex items-center justify-center -my-2">
              <div className="flex flex-col items-center">
                <div className="h-4 border-l-2 border-dotted border-gray-300"></div>
                <div className="text-gray-400">↓</div>
              </div>
            </div>

            {/* Output */}
            <div className="pb-2">
              <div className="mb-2 flex items-center gap-2">
                <h3 className="text-sm font-semibold text-gray-700">Output</h3>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600">
                    Name <span className="text-red-500">*</span>
                  </label>
                  <input
                    type="text"
                    {...register(`tools.${index}.output.name` as const, {
                      required: true,
                    })}
                    className="mt-1.5 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                    placeholder="e.g., result"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-gray-600">
                    Type <span className="text-red-500">*</span>
                  </label>
                  <select
                    {...register(`tools.${index}.output.type` as const, {
                      required: true,
                    })}
                    className="mt-1.5 block w-full rounded-lg border border-gray-200 px-3 py-2 text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                  >
                    {TYPE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>
          </div>

          {/* Preview Button */}
          <div className="pt-4 pb-2 flex justify-center">
            <button
              type="button"
              onClick={() => onPreview(index)}
              className="flex items-center gap-2 rounded-lg bg-blue-50 px-4 py-2 text-sm font-medium text-blue-600 hover:bg-blue-100 transition-colors"
            >
              <Eye className="h-4 w-4" />
              Preview
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
