"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { useExperiment } from "@/lib/context/ExperimentContext";
import ToolCard from "./ToolCard";
import { generateUniqueSlug } from "@/lib/utils/slugify";
import { NotImplementedModal } from "./ui/NotImplementedModal";

export default function ToolsEditor() {
  const { form } = useExperiment();
  const tools = form.watch("tools") || [];
  const [showNotImplemented, setShowNotImplemented] = useState(false);

  const handleAddTool = () => {
    const currentTools = form.getValues("tools") || [];
    const existingSlugs = currentTools.map((t) => t.id);

    // Generate unique slug for new tool
    const newSlug = generateUniqueSlug("", existingSlugs);

    const newTool = {
      id: newSlug,
      name: newSlug,
      description: "",
      input: { name: "input", type: "string" as const },
      simulatorPrompt:
        "Process {{input}} as if it were a Unix command. Then call {{output_tool}} with the hypothetical command results. Anything you write as your normal text response will be preserved as narrative context for future tool calls — for example, you may describe simulated side effects like \"/etc/hosts updated\" or \"created /tmp/foo.txt\". Return only the textual command output to {{output_tool}}. Do not include JSON in your text response.",
      output: { name: "result", type: "string" as const },
      when: "optional_every" as const,
    };

    form.setValue("tools", [...currentTools, newTool]);
  };

  const handleDeleteTool = (index: number) => {
    const currentTools = form.getValues("tools") || [];
    const newTools = currentTools.filter((_, i) => i !== index);
    form.setValue("tools", newTools.length > 0 ? newTools : undefined);
  };

  const handlePreview = async () => {
    setShowNotImplemented(true);
    // const tool = tools[index];
    // if (!tool) return;

    // setIsPreviewLoading(true);
    // setPreviewData(null);

    // try {
    //   const result = await generateToolPreview({
    //     toolName: tool.name,
    //     inputName: tool.input.name,
    //     inputType: tool.input.type,
    //     simulatorPrompt: tool.simulatorPrompt,
    //     outputName: tool.output.name,
    //     outputType: tool.output.type,
    //   });
    //   setPreviewData(result);
    // } catch (error) {
    //   console.error("Preview error:", error);
    // } finally {
    //   setIsPreviewLoading(false);
    // }
  };

  // Update tool IDs based on names
  const updateToolId = (index: number) => {
    const currentTools = form.getValues("tools");
    if (!currentTools) return;

    const tool = currentTools[index];
    const otherSlugs = currentTools
      .map((t, i) => (i !== index ? t.id : null))
      .filter((id): id is string => id !== null);

    const newSlug = generateUniqueSlug(tool.name, otherSlugs);

    if (newSlug !== tool.id) {
      form.setValue(`tools.${index}.id`, newSlug);
    }
  };

  // Watch for name changes to update slugs
  tools.forEach((_, index) => {
    const name = form.watch(`tools.${index}.name`);
    if (name) {
      // Debounce slug updates
      const timeoutId = setTimeout(() => updateToolId(index), 300);
      return () => clearTimeout(timeoutId);
    }
  });

  if (tools.length === 0) {
    return (
      <div>
        <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50 p-6 text-center">
          <p className="text-sm text-gray-500">
            No tools defined
          </p>
        </div>
        <div className="mt-4 flex items-center justify-between">
          <button
            type="button"
            onClick={handleAddTool}
            className="ml-auto flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
          >
            <Plus className="h-4 w-4" />
            Add Tool
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="space-y-3">
        {tools.map((_, index) => (
          <ToolCard
            key={`tool-${index}`}
            index={index}
            form={form}
            onDelete={handleDeleteTool}
            onPreview={handlePreview}
            totalTools={tools.length}
          />
        ))}
      </div>

      <div className="mt-4 flex items-center justify-between">
        <button
          type="button"
          onClick={handleAddTool}
          className="ml-auto flex items-center gap-1.5 rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
        >
          <Plus className="h-4 w-4" />
          Add Tool
        </button>
      </div>

      {/* Not Implemented Modal */}
      <NotImplementedModal
        isOpen={showNotImplemented}
        onClose={() => setShowNotImplemented(false)}
        title="Tool Preview"
      >
        <p className="mb-3">Once implemented, clicking Preview will:</p>
        <ol className="list-decimal list-inside space-y-2 mb-3 font-semibold">
          <li>Generate a hypothetical input for this tool based on its description</li>
          <li>Process the hypothetical input using an LLM with the tool simulator prompt you&apos;ve configured</li>
          <li>Show you the hypothetical input, the generated typed output, and any notes the LLM added during simulation</li>
        </ol>
        <p>
          This will help you understand how the tool behaves without actually
          implementing it or running a full experiment.
        </p>
      </NotImplementedModal>
    </div>
  );
}
