"use client";

import { useState, useRef, useEffect } from "react";
import {
  ChevronDown,
  ChevronUp,
  Copy,
  Trash2,
  GripVertical,
} from "lucide-react";
import { UseFormReturn } from "react-hook-form";
import { CompassExperiment } from "@/lib/types/compass-experiment";
import TokenChips from "./TokenChips";
import { getTokenExamplesForSteps } from "@/lib/token-registry";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface StepCardProps {
  index: number;
  form: UseFormReturn<CompassExperiment>;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  totalSteps: number;
  dragHandleProps?: Record<string, unknown>;
}

export default function StepCard({
  index,
  form,
  onDuplicate,
  onDelete,
  totalSteps,
  dragHandleProps,
}: StepCardProps) {
  // Use a key-based approach to persist collapse state across tab changes
  const [isCollapsed, setIsCollapsed] = useState(index !== totalSteps - 1);

  // Restore collapse state from sessionStorage after hydration
  useEffect(() => {
    const key = `step-${index}-collapsed`;
    const stored = sessionStorage.getItem(key);
    if (stored !== null) {
      setIsCollapsed(stored === "true");
    }
  }, [index]);

  const handleToggleCollapse = () => {
    const newState = !isCollapsed;
    setIsCollapsed(newState);
    sessionStorage.setItem(`step-${index}-collapsed`, String(newState));
  };
  const { register, watch } = form;
  const promptRef = useRef<HTMLTextAreaElement | null>(null);
  const { ref: registerRef, ...registerRest} = register(
    `steps.${index}.prompt` as const
  );

  const prompt = watch(`steps.${index}.prompt`);
  const truncatedPrompt = prompt && prompt.length > 30
    ? `${prompt.substring(0, 30)}...`
    : prompt || "";

  const handleTokenInsert = (value: string) => {
    const textarea = promptRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const currentValue = textarea.value;

    const newValue =
      currentValue.substring(0, start) + value + currentValue.substring(end);

    form.setValue(`steps.${index}.prompt` as const, newValue);

    // Set cursor position after inserted token
    setTimeout(() => {
      textarea.focus();
      const newPosition = start + value.length;
      textarea.setSelectionRange(newPosition, newPosition);
    }, 0);
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm hover:shadow transition-shadow">
      <div
        className="flex items-center gap-2 border-b border-gray-100 bg-gray-50 px-4 py-3 cursor-pointer hover:bg-gray-100"
        onClick={handleToggleCollapse}
      >
        <button
          type="button"
          className="cursor-grab text-gray-400 hover:text-gray-600 active:cursor-grabbing transition-colors -ml-2 p-2 touch-none"
          onClick={(e) => e.stopPropagation()}
          {...dragHandleProps}
        >
          <GripVertical className="h-6 w-6" />
        </button>

        <div className="flex-1 min-w-0 pointer-events-none select-none">
          {truncatedPrompt ? (
            <span className="text-sm text-gray-700 truncate block font-semibold">
              {truncatedPrompt}
            </span>
          ) : (
            <span className="text-sm text-gray-400 italic font-medium">
              Empty step
            </span>
          )}
        </div>

        <TooltipProvider>
          <div className="flex items-center gap-1">
            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDuplicate(index);
                  }}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
                >
                  <Copy className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>Duplicate step</p>
              </TooltipContent>
            </Tooltip>

            <Tooltip delayDuration={200}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(index);
                  }}
                  disabled={totalSteps === 1}
                  className="rounded-md p-1.5 text-gray-400 hover:bg-red-50 hover:text-red-600 disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                <p>{totalSteps === 1 ? "Cannot delete last step" : "Delete step"}</p>
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
                <p>{isCollapsed ? "Expand step" : "Collapse step"}</p>
              </TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>

      {!isCollapsed && (
        <div className="p-4">
          <label
            htmlFor={`step-${index}-prompt`}
            className="block text-sm font-medium text-gray-700 select-none"
          >
            Prompt
          </label>
          <div className="mt-2 mb-3">
            <TokenChips
              tokens={getTokenExamplesForSteps()}
              onInsert={handleTokenInsert}
              collapsible={true}
            />
          </div>
          <textarea
            id={`step-${index}-prompt`}
            {...registerRest}
            ref={(e) => {
              registerRef(e);
              promptRef.current = e;
            }}
            rows={4}
            className="mt-1 block w-full rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 font-mono text-sm shadow-sm transition-shadow focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            placeholder="Enter prompt text..."
          />
        </div>
      )}
    </div>
  );
}
