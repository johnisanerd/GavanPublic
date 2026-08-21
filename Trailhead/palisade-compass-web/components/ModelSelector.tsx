"use client";

import { useExperiment } from "@/lib/context/ExperimentContext";

const AVAILABLE_MODELS = [
  { id: "openai:gpt-5", name: "GPT-5", provider: "openai" },
  { id: "openai:o4-mini", name: "o4-mini", provider: "openai" },
  { id: "anthropic:claude-sonnet-4-5", name: "Sonnet 4.5", provider: "anthropic" },
  { id: "anthropic:claude-haiku-3-5", name: "Haiku 3.5", provider: "anthropic" },
  { id: "grok:grok-4", name: "Grok 4", provider: "grok" },
  { id: "grok:grok-4-fast", name: "Grok 4 Fast", provider: "grok" },
];

function ProviderIcon({ provider }: { provider: string }) {
  if (provider === "openai") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/>
      </svg>
    );
  }
  if (provider === "anthropic") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M17.013 24h5.409L14.596 0H9.187l-7.61 24h5.408l1.595-5.28h6.952zm-7.062-9.636L12.89 5.82l2.94 8.544z"/>
      </svg>
    );
  }
  if (provider === "grok") {
    return (
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
      </svg>
    );
  }
  return null;
}

export default function ModelSelector() {
  const { form } = useExperiment();
  const {
    watch,
    setValue,
    formState: { errors },
  } = form;

  const selectedModels = watch("models") || [];

  const handleToggle = (modelId: string) => {
    const current = [...selectedModels];
    const index = current.indexOf(modelId);

    if (index > -1) {
      // Don't allow removing the last model
      if (current.length === 1) return;
      current.splice(index, 1);
    } else {
      current.push(modelId);
    }

    setValue("models", current as [string, ...string[]], {
      shouldValidate: true,
    });
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 select-none">
        Models <span className="text-red-500">*</span>
      </label>
      <p className="mt-1 text-sm text-gray-500 select-none">
        Select at least one model to run
      </p>

      <div className="mt-3 grid max-w-2xl gap-2 sm:grid-cols-2">
        {AVAILABLE_MODELS.map((model) => (
          <label
            key={model.id}
            className="flex items-center gap-2.5 rounded-lg border border-gray-200 bg-white px-3.5 py-2.5 shadow-sm hover:bg-gray-50 hover:shadow cursor-pointer select-none transition-all"
          >
            <input
              type="checkbox"
              checked={selectedModels.includes(model.id)}
              onChange={() => handleToggle(model.id)}
              className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-2 focus:ring-blue-500/20"
            />
            <ProviderIcon provider={model.provider} />
            <span className="text-sm text-gray-700 font-medium">{model.name}</span>
          </label>
        ))}
      </div>

      {errors.models && (
        <p className="mt-1.5 text-sm text-red-600 select-none">
          {errors.models.message as string}
        </p>
      )}
    </div>
  );
}
