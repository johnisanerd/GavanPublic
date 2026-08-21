"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { FilePlus, X, Copy, Check, Sparkles } from "lucide-react";
import { useExperiment } from "@/lib/context/ExperimentContext";
import { downloadExperiment } from "@/lib/utils/import-export";
import { getExperimentCreationPrompt } from "@/app/actions/get-experiment-prompt";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface NewExperimentButtonProps {
  onOpenImport?: () => void;
}

export default function NewExperimentButton({ onOpenImport }: NewExperimentButtonProps) {
  const { form, hasUnsavedChanges, resetExperiment } = useExperiment();
  const [showUnsavedDialog, setShowUnsavedDialog] = useState(false);
  const [showNewDialog, setShowNewDialog] = useState(false);
  const [showAIPrompt, setShowAIPrompt] = useState(false);
  const [aiPrompt, setAIPrompt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [aiPromptStep, setAIPromptStep] = useState<"prompt" | "continue">("prompt");

  const handleNew = () => {
    if (hasUnsavedChanges) {
      setShowUnsavedDialog(true);
    } else {
      setShowNewDialog(true);
    }
  };

  const handleDownload = () => {
    const experiment = form.getValues();
    downloadExperiment(experiment, "yaml");
    setShowUnsavedDialog(false);
    setShowNewDialog(true);
  };

  const handleDiscard = () => {
    setShowUnsavedDialog(false);
    setShowNewDialog(true);
  };

  const handleStartFromScratch = () => {
    resetExperiment();
    setShowNewDialog(false);
  };

  const handleShowAIPrompt = async () => {
    if (!aiPrompt) {
      const prompt = await getExperimentCreationPrompt();
      setAIPrompt(prompt);
    }
    setShowAIPrompt(true);
    setShowNewDialog(false);
  };

  const handleCopyPrompt = async () => {
    if (!aiPrompt) return;

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(aiPrompt);
      } else {
        // Fallback for older browsers/iOS
        const textArea = document.createElement('textarea');
        textArea.value = aiPrompt;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 2000);

      // Move to continue step after copying
      setTimeout(() => {
        setAIPromptStep("continue");
      }, 500);
    } catch (error) {
      console.error('Failed to copy:', error);
      // Still move to continue step even if copy fails
      setAIPromptStep("continue");
    }
  };

  const handleContinueToImport = () => {
    setShowAIPrompt(false);
    setAIPromptStep("prompt");
    onOpenImport?.();
  };

  const handleCloseAIPrompt = () => {
    setShowAIPrompt(false);
    setAIPromptStep("prompt");
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              onClick={handleNew}
              className="flex flex-col sm:flex-row items-center gap-0 sm:gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 sm:px-3 sm:py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500/20 select-none transition-all"
            >
              <FilePlus className="h-4 w-4" />
              <span className="text-[8px] leading-none uppercase font-semibold tracking-wide sm:text-sm sm:normal-case sm:font-medium sm:tracking-normal sm:leading-normal">New</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>Create new experiment</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      {/* Unsaved Changes Dialog */}
      {showUnsavedDialog && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-[33vh]"
          onClick={() => setShowUnsavedDialog(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Unsaved Changes</h3>
                <p className="mt-1 text-sm text-gray-500">
                  You have unsaved changes. Download before continuing?
                </p>
              </div>
              <button
                onClick={() => setShowUnsavedDialog(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 flex justify-end gap-2">
              <button
                onClick={() => setShowUnsavedDialog(false)}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDiscard}
                className="rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
              >
                Discard
              </button>
              <button
                onClick={handleDownload}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
              >
                Download
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* New Experiment Dialog */}
      {showNewDialog && createPortal(
        <div
          className="fixed inset-0 z-[100] flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-[33vh]"
          onClick={() => setShowNewDialog(false)}
        >
          <div
            className="w-full max-w-md rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">Create New Experiment</h3>
                <p className="mt-1 text-sm text-gray-500">
                  Choose how you&apos;d like to create your experiment
                </p>
              </div>
              <button
                onClick={() => setShowNewDialog(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-3">
              {/* Start from Scratch */}
              <button
                onClick={handleStartFromScratch}
                className="w-full rounded-lg border border-gray-300 bg-white p-4 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <FilePlus className="h-5 w-5 text-gray-700 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">Start from scratch</p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      Create a blank experiment and build it manually
                    </p>
                  </div>
                </div>
              </button>

              {/* Generate with AI */}
              <button
                onClick={handleShowAIPrompt}
                className="w-full rounded-lg border border-gray-300 bg-white p-4 text-left hover:bg-gray-50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  <Sparkles className="h-5 w-5 text-gray-700 mt-0.5 flex-shrink-0" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-gray-900">Copy AI Prompt</p>
                    <p className="text-xs text-gray-600 mt-0.5">
                      Get a prompt to paste into your favorite LLM to interactively design an experiment
                    </p>
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* AI Prompt Dialog */}
      {showAIPrompt && createPortal(
        <div
          className="fixed inset-0 z-[101] flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-16 sm:pt-[33vh]"
          onClick={handleCloseAIPrompt}
        >
          <div
            className="w-full max-w-2xl rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">AI Experiment Generator</h3>
                {aiPromptStep === "prompt" && (
                  <p className="mt-1 text-sm text-gray-500">
                    Copy this prompt and paste it into ChatGPT, Claude, or your favorite LLM
                  </p>
                )}
              </div>
              <button
                onClick={handleCloseAIPrompt}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {aiPromptStep === "prompt" ? (
                <>
                  <div className="bg-blue-50 border-2 border-blue-200 rounded-lg p-4">
                    <p className="text-sm font-semibold text-gray-900 mb-2">
                      📋 Instructions:
                    </p>
                    <ol className="text-sm text-gray-700 space-y-1 list-decimal list-inside">
                      <li>Copy the prompt below</li>
                      <li>Paste it into your LLM (ChatGPT, Claude, etc.)</li>
                      <li>Follow the interactive prompts to design your experiment</li>
                      <li>Copy or download the generated YAML configuration</li>
                    </ol>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium text-gray-500">
                      Generator Prompt:
                    </p>
                    <div className="relative max-h-32 sm:max-h-64 overflow-y-auto rounded-lg border border-gray-300 bg-gray-50">
                      <pre className="p-3 text-xs leading-relaxed text-gray-500 font-mono whitespace-pre-wrap break-words">
{aiPrompt || "Loading prompt..."}
                      </pre>
                    </div>
                  </div>

                  <div className="flex justify-end">
                    <button
                      onClick={handleCopyPrompt}
                      className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors flex items-center gap-2"
                    >
                      {copied ? (
                        <>
                          <Check className="h-4 w-4" />
                          Copied!
                        </>
                      ) : (
                        <>
                          <Copy className="h-4 w-4" />
                          Copy Prompt
                        </>
                      )}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="py-12 text-center space-y-4">
                    <div className="text-5xl mb-4">✨</div>
                    <div>
                      <p className="text-xl font-semibold text-gray-900 mb-2">
                        Paste the prompt into your LLM
                      </p>
                      <p className="text-sm text-gray-600 max-w-md mx-auto">
                        Once you have your experiment configuration downloaded or&nbsp;copied,<br/>click Continue
                      </p>
                    </div>
                  </div>

                  <div className="flex justify-center">
                    <button
                      onClick={handleContinueToImport}
                      className="px-6 py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
                    >
                      Continue
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
