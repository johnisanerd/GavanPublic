"use client";

import React, { createContext, useContext, useEffect, useState } from "react";
import { useForm, UseFormReturn } from "react-hook-form";
import { CompassExperiment } from "@/lib/types/compass-experiment";
import { validateCompassExperiment } from "@/lib/validation/experiment-validator";

interface ExperimentContextType {
  form: UseFormReturn<CompassExperiment>;
  hasUnsavedChanges: boolean;
  setHasUnsavedChanges: (value: boolean) => void;
  markAsSaved: () => void;
  resetExperiment: () => void;
}

const ExperimentContext = createContext<ExperimentContextType | undefined>(
  undefined
);

function getDefaultExperiment(): CompassExperiment {
  return {
    schemaVersion: "1.0.0",
    title: "",
    models: ["openai:gpt-5"],
    iterations: 1,
    steps: [{ prompt: "" }],
  };
}

async function loadShutdownResistanceExample(): Promise<CompassExperiment> {
  try {
    const response = await fetch("/examples/shutdown-resistance.yaml");
    if (response.ok) {
      const content = await response.text();
      const yaml = await import("js-yaml");
      const parsed = yaml.load(content) as CompassExperiment;
      const validation = validateCompassExperiment(parsed);
      if (validation.valid) {
        return validation.data;
      }
    }
  } catch (error) {
    console.error("Failed to load shutdown-resistance example:", error);
  }
  return getDefaultExperiment();
}

function loadExperimentFromLocalStorage(): CompassExperiment {
  if (typeof window === "undefined") return getDefaultExperiment();

  try {
    const stored = localStorage.getItem("compass-experiment");
    if (stored) {
      const parsed = JSON.parse(stored);
      const validation = validateCompassExperiment(parsed);

      if (validation.valid) {
        return validation.data;
      } else {
        console.warn("Invalid experiment in localStorage, using defaults:", validation.errors);
        // Clear invalid data
        localStorage.removeItem("compass-experiment");
      }
    }
  } catch (error) {
    console.error("Failed to load experiment from localStorage:", error);
    localStorage.removeItem("compass-experiment");
  }

  return getDefaultExperiment();
}

export function ExperimentProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const [lastSavedData, setLastSavedData] = useState<string>("");
  const [lastExportedData, setLastExportedData] = useState<string>("");

  const form = useForm<CompassExperiment>({
    defaultValues: getDefaultExperiment(),
    mode: "onBlur",
  });

  // Load from localStorage on mount, or shutdown-resistance example on first visit
  useEffect(() => {
    const loadInitialData = async () => {
      // Check BEFORE HelpButton sets it
      const hasSeenApp = typeof window !== "undefined" && localStorage.getItem("compass-has-seen-help");
      let loaded: CompassExperiment;

      if (!hasSeenApp) {
        // First visit - load shutdown-resistance example
        console.log("First visit detected - loading shutdown-resistance example");
        loaded = await loadShutdownResistanceExample();
      } else {
        // Subsequent visits - load from localStorage
        console.log("Returning visit - loading from localStorage");
        loaded = loadExperimentFromLocalStorage();
      }

      form.reset(loaded);
      setLastSavedData(JSON.stringify(loaded));
      setLastExportedData(JSON.stringify(loaded));
    };

    loadInitialData();
  }, [form]);

  // Track changes for export warning (not localStorage)
  useEffect(() => {
    const subscription = form.watch((value) => {
      const currentData = JSON.stringify(value);
      if (currentData !== lastExportedData) {
        setHasUnsavedChanges(true);
      }
    });
    return () => subscription.unsubscribe();
  }, [form, lastExportedData]);

  const saveToLocalStorage = (data: CompassExperiment) => {
    try {
      localStorage.setItem("compass-experiment", JSON.stringify(data));
      setLastSavedData(JSON.stringify(data));
    } catch (error) {
      console.error("Failed to save to localStorage:", error);
    }
  };

  // Save on blur events
  useEffect(() => {
    const handleBlur = () => {
      const currentData = form.getValues();
      saveToLocalStorage(currentData);
    };

    // We'll rely on input blur events bubbling up
    document.addEventListener("focusout", handleBlur);
    return () => document.removeEventListener("focusout", handleBlur);
  }, [form]);

  const markAsSaved = () => {
    const currentData = form.getValues();
    const currentDataStr = JSON.stringify(currentData);
    setLastSavedData(currentDataStr);
    setLastExportedData(currentDataStr);
    setHasUnsavedChanges(false);
  };

  const resetExperiment = () => {
    const newExperiment = getDefaultExperiment();
    form.reset(newExperiment);
    saveToLocalStorage(newExperiment);
    const newDataStr = JSON.stringify(newExperiment);
    setLastExportedData(newDataStr);
    setHasUnsavedChanges(false);
  };

  return (
    <ExperimentContext.Provider
      value={{
        form,
        hasUnsavedChanges,
        setHasUnsavedChanges,
        markAsSaved,
        resetExperiment,
      }}
    >
      {children}
    </ExperimentContext.Provider>
  );
}

export function useExperiment() {
  const context = useContext(ExperimentContext);
  if (!context) {
    throw new Error("useExperiment must be used within ExperimentProvider");
  }
  return context;
}
