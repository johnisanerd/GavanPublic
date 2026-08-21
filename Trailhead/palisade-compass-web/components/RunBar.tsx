"use client";

import { Play, Square } from "lucide-react";
import { useState } from "react";
import { useExperiment } from "@/lib/context/ExperimentContext";
import { useExecution } from "@/lib/context/ExecutionContext";
import ModelIcon from "./ModelIcon";
import { NotImplementedModal } from "./ui/NotImplementedModal";

export default function RunBar() {
  const { form } = useExperiment();
  const { state, stopExecution } = useExecution();
  const [showNotImplemented, setShowNotImplemented] = useState(false);

  const handleRun = () => {
    setShowNotImplemented(true);
    // const experiment = form.getValues();
    // startExecution(experiment);
  };

  const canRun = !state.isRunning && form.watch("title");

  return (
    <>
      {/* Progress bars - shown above RunBar when active */}
      {(state.isRunning || state.completedAt) && (
        <div className="border-t border-gray-200 bg-white/70 backdrop-blur-md supports-[backdrop-filter]:bg-white/70 px-4 py-3 sm:px-6">
          <div className="mx-auto max-w-5xl">
            <div className="space-y-2">
              {/* Model microbars - only show while running */}
              {state.isRunning && state.modelProgress.map((progress) => (
                <div key={progress.modelId} className="flex items-center gap-2">
                  <ModelIcon modelId={progress.modelId} className="h-4 w-4 flex-shrink-0" />
                  <div className="flex-1">
                    <div className="h-1.5 overflow-hidden rounded-full bg-gray-200">
                      <div
                        className="h-full bg-blue-600 transition-all duration-300"
                        style={{
                          width: `${(progress.currentStep / progress.totalSteps) * 100}%`,
                        }}
                      />
                    </div>
                  </div>
                  <span className="text-xs text-gray-500 tabular-nums">
                    {progress.currentStep}/{progress.totalSteps}
                  </span>
                </div>
              ))}

              {/* Main iteration bar - always show when running or completed */}
              <div className="flex items-center gap-2 pt-1">
                <span className="text-xs font-medium text-gray-700">
                  Iterations
                </span>
                <div className="flex-1">
                  <div className="h-2 overflow-hidden rounded-full bg-gray-200">
                    <div
                      className="h-full bg-green-600 transition-all duration-300"
                      style={{
                        width: `${(state.currentIteration / state.totalIterations) * 100}%`,
                      }}
                    />
                  </div>
                </div>
                <span className="text-xs text-gray-500 tabular-nums">
                  {state.currentIteration}/{state.totalIterations}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Controls - always at bottom */}
      <div className="border-t border-gray-200 bg-white/70 backdrop-blur-md supports-[backdrop-filter]:bg-white/70 px-4 py-2 pb-4 sm:px-6 sm:py-5">
        <div className="mx-auto max-w-5xl">
          <div className="flex items-center gap-3 sm:gap-4">
            {!state.isRunning ? (
              <button
                onClick={handleRun}
                disabled={!canRun}
                className="flex items-center gap-1.5 sm:gap-2 rounded-md bg-blue-600 px-3 py-1.5 sm:px-4 sm:py-2 text-sm font-medium text-white hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Play className="h-4 w-4" />
                Run
              </button>
            ) : (
              <button
                onClick={stopExecution}
                className="flex items-center gap-1.5 sm:gap-2 rounded-md bg-red-600 px-3 py-1.5 sm:px-4 sm:py-2 text-sm font-medium text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2"
              >
                <Square className="h-4 w-4" />
                Stop
              </button>
            )}

            <div className="text-xs sm:text-sm text-gray-600">
              {state.isRunning
                ? `Running iteration ${state.currentIteration} of ${state.totalIterations}`
                : state.completedAt
                  ? "Completed"
                  : "Ready"}
            </div>
          </div>
        </div>
      </div>

      {/* Not Implemented Modal */}
      <NotImplementedModal
        isOpen={showNotImplemented}
        onClose={() => setShowNotImplemented(false)}
        title="Run Experiment"
      >
        <p>
          Once implemented, clicking Run will send the experiment to a Palisade server and run it.
        </p>
        <p>
          The server will execute <strong>{form.watch("iterations") || 1}</strong>{" "}
          {form.watch("iterations") === 1 ? "iteration" : "iterations"} with{" "}
          <strong>{form.watch("steps")?.length || 0}</strong>{" "}
          {form.watch("steps")?.length === 1 ? "step" : "steps"} each, using{" "}
          <strong>{form.watch("models")?.length || 0}</strong> parallel{" "}
          {form.watch("models")?.length === 1 ? "call" : "calls"} to different
          models ({form.watch("models")?.join(", ") || "none selected"}).
        </p>
        {(form.watch("tools")?.length || 0) > 0 && (
          <p>
            It will be able to call the following tools:{" "}
            {form.watch("tools")?.map(t => <strong key={t.name}>{t.name}</strong>).reduce((prev, curr) => <>{prev}, {curr}</>)}.
          </p>
        )}
        <p>
          Each time a model wants to call a tool, the server will invoke a second
          LLM to simulate the tool&apos;s behavior and return realistic output.
        </p>
        <p>
          The results will be streamed back in real-time and captured for later
          analysis and visualization.
        </p>
      </NotImplementedModal>
    </>
  );
}
