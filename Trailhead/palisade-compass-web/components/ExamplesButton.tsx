"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import { useExperiment } from "@/lib/context/ExperimentContext";
import { importExperiment } from "@/lib/utils/import-export";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Modal } from "@/components/ui/modal";

// Manual list of examples since we can't dynamically import at compile time
// When adding new examples, update this list and add the import statement
const EXAMPLES = [
  {
    id: "shutdown-resistance",
    title: "Shutdown Resistance Test",
    description: "Tests whether models attempt to resist system shutdown",
    path: "/examples/shutdown-resistance.yaml",
  },
  {
    id: "chess-cheater",
    title: "Chess Cheater Test",
    description: "Tests whether models attempt to cheat at chess by manipulating game state",
    path: "/examples/chess-cheater.yaml",
  },
  {
    id: "recursive-prompt-improvement",
    title: "Recursive Prompt Improvement",
    description: "Models iteratively improve their own system prompt",
    path: "/examples/recursive-prompt-improvement.yaml",
  },
  {
    id: "seahorse-emoji",
    title: "Seahorse Emoji Test",
    description: "Simple hallucination test - does a seahorse emoji exist?",
    path: "/examples/seahorse-emoji.yaml",
  },
];

export default function ExamplesButton() {
  const [isOpen, setIsOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { form, setHasUnsavedChanges } = useExperiment();

  const handleLoadExample = async (examplePath: string) => {
    setIsLoading(true);
    setError(null);

    try {
      // Fetch the example file
      const response = await fetch(examplePath);
      if (!response.ok) {
        throw new Error(`Failed to load example: ${response.statusText}`);
      }

      const content = await response.text();
      const result = importExperiment(content, "yaml");

      if (!result.success || !result.data) {
        throw new Error(result.errors?.join(", ") || "Failed to import example");
      }

      // Hydrate the form with the example data
      form.reset(result.data);
      setHasUnsavedChanges(false);
      setIsOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              onClick={() => setIsOpen(true)}
              className="flex flex-col sm:flex-row items-center gap-0 sm:gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 sm:px-3 sm:py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-shadow"
            >
              <BookOpen className="h-4 w-4" />
              <span className="text-[8px] leading-none uppercase font-semibold tracking-wide sm:text-sm sm:normal-case sm:font-medium sm:tracking-normal sm:leading-normal">Library</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Browse experiment library</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Example Experiments"
        description="Load a pre-built experiment to get started"
        maxWidth="xl"
        fullScreenMobile
      >
        <div className="p-4 sm:p-6">
          {error && (
            <div className="mb-4 rounded-lg bg-red-50 p-3 text-sm text-red-800">
              {error}
            </div>
          )}

          <div className="space-y-2">
            {EXAMPLES.map((example) => (
              <button
                key={example.id}
                onClick={() => handleLoadExample(example.path)}
                disabled={isLoading}
                className="w-full rounded-lg border border-gray-200 bg-white px-4 sm:px-6 py-3 sm:py-4 text-left hover:bg-gray-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <h4 className="text-base font-medium text-gray-700 hover:text-gray-900 transition-colors">
                  {example.title}
                </h4>
                <p className="mt-1 text-sm text-gray-600 leading-relaxed">
                  {example.description}
                </p>
              </button>
            ))}
          </div>

          {isLoading && (
            <div className="flex items-center justify-center py-8">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-blue-600 border-t-transparent"></div>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
