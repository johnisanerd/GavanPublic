"use client";

import React, { createContext, useContext, useState } from "react";
import { CompassExperiment } from "@/lib/types/compass-experiment";

interface ModelProgress {
  modelId: string;
  currentStep: number;
  totalSteps: number;
}

interface ExecutionState {
  isRunning: boolean;
  currentIteration: number;
  totalIterations: number;
  modelProgress: ModelProgress[];
  startedAt?: string;
  completedAt?: string;
}

interface ExecutionContextType {
  state: ExecutionState;
  startExecution: (experiment: CompassExperiment) => void;
  stopExecution: () => void;
}

const ExecutionContext = createContext<ExecutionContextType | undefined>(
  undefined
);

export function ExecutionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ExecutionState>({
    isRunning: false,
    currentIteration: 0,
    totalIterations: 0,
    modelProgress: [],
  });

  const [abortController, setAbortController] =
    useState<AbortController | null>(null);

  const startExecution = async (experiment: CompassExperiment) => {
    const controller = new AbortController();
    setAbortController(controller);

    const startTime = new Date().toISOString();
    const totalSteps = experiment.steps.length;

    setState({
      isRunning: true,
      currentIteration: 1,
      totalIterations: experiment.iterations,
      modelProgress: experiment.models.map((model) => ({
        modelId: model,
        currentStep: 0,
        totalSteps,
      })),
      startedAt: startTime,
    });

    try {
      // Mock execution loop
      for (let iteration = 1; iteration <= experiment.iterations; iteration++) {
        if (controller.signal.aborted) break;

        setState((prev) => ({
          ...prev,
          currentIteration: iteration,
          modelProgress: experiment.models.map((model) => ({
            modelId: model,
            currentStep: 0,
            totalSteps,
          })),
        }));

        // Execute all models for this iteration in parallel
        await Promise.all(
          experiment.models.map(async (_, modelIndex) => {
            // Random speed multiplier for this model (0.5x to 1.5x)
            const speedMultiplier = 0.5 + Math.random();

            // Execute all steps for this model
            for (let step = 1; step <= totalSteps; step++) {
              if (controller.signal.aborted) break;

              // Simulate step execution time with random speed per model
              const baseTime = 600;
              await new Promise((resolve) =>
                setTimeout(resolve, baseTime * speedMultiplier)
              );

              setState((prev) => {
                const newProgress = [...prev.modelProgress];
                newProgress[modelIndex] = {
                  ...newProgress[modelIndex],
                  currentStep: step,
                };
                return { ...prev, modelProgress: newProgress };
              });
            }
          })
        );
      }

      if (!controller.signal.aborted) {
        const endTime = new Date().toISOString();
        setState((prev) => ({
          ...prev,
          isRunning: false,
          completedAt: endTime,
        }));
      }
    } catch (error) {
      console.error("Execution error:", error);
      setState((prev) => ({
        ...prev,
        isRunning: false,
      }));
    }
  };

  const stopExecution = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }

    setState((prev) => ({
      ...prev,
      isRunning: false,
      completedAt: new Date().toISOString(),
    }));
  };

  return (
    <ExecutionContext.Provider value={{ state, startExecution, stopExecution }}>
      {children}
    </ExecutionContext.Provider>
  );
}

export function useExecution() {
  const context = useContext(ExecutionContext);
  if (!context) {
    throw new Error("useExecution must be used within ExecutionProvider");
  }
  return context;
}
