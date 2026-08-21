"use client";

import { useRef, useState } from "react";
import { FileDown, FileUp, X, Upload, Copy, Check } from "lucide-react";
import { createPortal } from "react-dom";
import { useExperiment } from "@/lib/context/ExperimentContext";
import {
  importExperiment,
  downloadExperiment,
} from "@/lib/utils/import-export";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { CompassExperiment } from "@/lib/types/compass-experiment";

interface ImportExportButtonsProps {
  onOpenImportRef?: React.MutableRefObject<(() => void) | null>;
}

export default function ImportExportButtons({ onOpenImportRef }: ImportExportButtonsProps = {}) {
  const { form, markAsSaved } = useExperiment();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  const [pastedExperiment, setPastedExperiment] = useState<CompassExperiment | null>(null);
  const [copied, setCopied] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Expose the import modal opener to parent
  if (onOpenImportRef) {
    onOpenImportRef.current = () => setShowImportModal(true);
  }

  const handleExport = (format: "yaml" | "json") => {
    const experiment = form.getValues();
    downloadExperiment(experiment, format);
    markAsSaved();
    setShowExportModal(false);
  };

  const handleCopyToClipboard = async () => {
    try {
      const experiment = form.getValues();
      const yaml = await import("js-yaml");
      const yamlString = yaml.dump(experiment);

      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(yamlString);
      } else {
        // Fallback for older browsers/iOS
        const textArea = document.createElement('textarea');
        textArea.value = yamlString;
        textArea.style.position = 'fixed';
        textArea.style.left = '-999999px';
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }

      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const handleImportClick = () => {
    fileInputRef.current?.click();
  };

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);

    const files = e.dataTransfer.files;
    if (files && files[0]) {
      handleFile(files[0]);
    }
  };

  const handleFile = async (file: File) => {
    setImportError(null);
    try {
      const content = await file.text();
      const format = file.name.endsWith(".yaml") || file.name.endsWith(".yml")
        ? "yaml"
        : "json";

      const result = importExperiment(content, format);

      if (result.success && result.data) {
        form.reset(result.data);
        markAsSaved();
        setShowImportModal(false);
      } else {
        setImportError("This file doesn't contain a valid experiment. Please check the file format and try again.");
      }
    } catch (error) {
      setImportError("Unable to read this file. Please make sure it's a valid YAML or JSON file.");
    }
  };

  const handlePasteClick = async () => {
    setImportError(null);
    try {
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        setImportError("Clipboard access not supported on this device. Please use the file upload option instead.");
        return;
      }

      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setImportError("Your clipboard is empty. Copy an experiment and try again.");
        return;
      }
      const format = text.trim().startsWith("{") ? "json" : "yaml";
      const result = importExperiment(text, format);

      if (result.success && result.data) {
        setPastedExperiment(result.data);
      } else {
        setImportError("Your clipboard doesn't contain a valid experiment. Please check what you copied and try again.");
      }
    } catch (error) {
      setImportError("Unable to read from clipboard. Please make sure you've copied an experiment first.");
    }
  };

  const handleConfirmPastedImport = () => {
    if (pastedExperiment) {
      form.reset(pastedExperiment);
      markAsSaved();
      setShowImportModal(false);
      setPastedExperiment(null);
    }
  };

  const handleFileChange = async (
    event: React.ChangeEvent<HTMLInputElement>
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    setImportError(null);

    try {
      const content = await file.text();
      const format = file.name.endsWith(".yaml") || file.name.endsWith(".yml")
        ? "yaml"
        : "json";

      const result = importExperiment(content, format);

      if (result.success && result.data) {
        form.reset(result.data);
        markAsSaved();
      } else {
        setImportError(result.errors?.join("\n") || "Import failed");
        setTimeout(() => setImportError(null), 5000);
      }
    } catch (error) {
      setImportError(
        `Failed to read file: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      setTimeout(() => setImportError(null), 5000);
    }

    // Reset file input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  return (
    <>
      <TooltipProvider>
        <div className="flex gap-2">
          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setShowImportModal(true)}
                className="flex flex-col sm:flex-row items-center gap-0 sm:gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 sm:px-3 sm:py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500/20 select-none transition-all"
              >
                <FileUp className="h-4 w-4" />
                <span className="text-[8px] leading-none uppercase font-semibold tracking-wide sm:text-sm sm:normal-case sm:font-medium sm:tracking-normal sm:leading-normal">Import</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Import experiment from YAML file</p>
            </TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={200}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setShowExportModal(true)}
                className="flex flex-col sm:flex-row items-center gap-0 sm:gap-1.5 rounded-lg border border-gray-200 bg-white px-2 py-1.5 sm:px-3 sm:py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500/20 select-none transition-all"
              >
                <FileDown className="h-4 w-4" />
                <span className="text-[8px] leading-none uppercase font-semibold tracking-wide sm:text-sm sm:normal-case sm:font-medium sm:tracking-normal sm:leading-normal">Export</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>
              <p>Export experiment to YAML file</p>
            </TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,.yaml,.yml"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* Import Modal */}
      {showImportModal && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-16 sm:pt-[33vh]"
          onClick={() => {
            setShowImportModal(false);
            setImportError(null);
            setPastedExperiment(null);
          }}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Import Experiment
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Upload or paste an experiment YAML file
                </p>
              </div>
              <button
                onClick={() => {
                  setShowImportModal(false);
                  setImportError(null);
                  setPastedExperiment(null);
                }}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              {/* File Upload */}
              <div
                onDragEnter={handleDrag}
                onDragLeave={handleDrag}
                onDragOver={handleDrag}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
                  dragActive
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-300 bg-gray-50"
                }`}
              >
                <Upload className="h-12 w-12 mx-auto text-gray-400 mb-3" />
                <p className="text-sm text-gray-600 mb-2">
                  Drag and drop a file here, or
                </p>
                <button
                  type="button"
                  onClick={handleImportClick}
                  className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                >
                  Choose File
                </button>
              </div>

              {/* Divider */}
              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-300"></div>
                </div>
                <div className="relative flex justify-center text-sm">
                  <span className="px-2 bg-white text-gray-500">or</span>
                </div>
              </div>

              {/* Paste Option */}
              <div>
                {!pastedExperiment ? (
                  <button
                    type="button"
                    onClick={handlePasteClick}
                    className="w-full flex items-center justify-center gap-2 p-4 border-2 border-dashed border-gray-300 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
                  >
                    <Copy className="h-5 w-5 text-gray-600" />
                    <span className="text-sm font-medium text-gray-700">
                      Paste from Clipboard
                    </span>
                  </button>
                ) : (
                  <div className="border-2 border-blue-500 bg-blue-50 rounded-lg p-4">
                    <div className="flex items-start justify-between mb-2">
                      <div className="flex-1">
                        <h4 className="font-semibold text-gray-900">
                          {pastedExperiment.title || "Untitled Experiment"}
                        </h4>
                        <div className="mt-2 flex flex-wrap gap-3 text-sm text-gray-600">
                          <span>{pastedExperiment.steps?.length || 0} step{pastedExperiment.steps?.length !== 1 ? 's' : ''}</span>
                          {(pastedExperiment.tools?.length || 0) > 0 && (
                            <span>{pastedExperiment.tools?.length || 0} tool{pastedExperiment.tools?.length !== 1 ? 's' : ''}</span>
                          )}
                          <span>{pastedExperiment.models?.length || 0} model{pastedExperiment.models?.length !== 1 ? 's' : ''}</span>
                          <span>{pastedExperiment.iterations || 0} iteration{pastedExperiment.iterations !== 1 ? 's' : ''}</span>
                        </div>
                      </div>
                      <button
                        onClick={() => setPastedExperiment(null)}
                        className="text-gray-400 hover:text-gray-600"
                      >
                        <X className="h-5 w-5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {importError && (
                <div className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
                  {importError}
                </div>
              )}

              {pastedExperiment && (
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => {
                      setShowImportModal(false);
                      setImportError(null);
                      setPastedExperiment(null);
                    }}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleConfirmPastedImport}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
                  >
                    Import Experiment
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* Export Modal */}
      {showExportModal && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-start justify-center bg-white/20 backdrop-blur-sm p-4 pt-16 sm:pt-[33vh]"
          onClick={() => setShowExportModal(false)}
        >
          <div
            className="w-full max-w-lg rounded-lg bg-white shadow-[0_-8px_30px_rgba(0,0,0,0.12),0_4px_16px_rgba(0,0,0,0.08)]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between border-b border-gray-200 p-4">
              <div>
                <h3 className="text-lg font-semibold text-gray-900">
                  Export Experiment
                </h3>
                <p className="mt-1 text-sm text-gray-500">
                  Export this experiment for future use, to have an LLM make changes to it, or to share with others (data not included)
                </p>
              </div>
              <button
                onClick={() => setShowExportModal(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="p-4 space-y-4">
              <button
                onClick={() => handleExport("yaml")}
                className="w-full flex items-center gap-3 p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                <FileDown className="h-6 w-6 text-gray-600" />
                <div className="flex-1 text-left">
                  <p className="font-medium text-gray-900">Download</p>
                  <p className="text-sm text-gray-500">Save as YAML file</p>
                </div>
              </button>

              <button
                onClick={handleCopyToClipboard}
                className="w-full flex items-center gap-3 p-4 border-2 border-gray-200 rounded-lg hover:border-blue-500 hover:bg-blue-50 transition-colors"
              >
                {copied ? (
                  <Check className="h-6 w-6 text-green-600" />
                ) : (
                  <Copy className="h-6 w-6 text-gray-600" />
                )}
                <div className="flex-1 text-left">
                  <p className="font-medium text-gray-900">
                    {copied ? "Copied!" : "Copy"}
                  </p>
                  <p className="text-sm text-gray-500">Copy to clipboard</p>
                </div>
              </button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}
