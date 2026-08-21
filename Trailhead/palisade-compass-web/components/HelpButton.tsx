"use client";

import { useState, useEffect } from "react";
import { HelpCircle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Modal } from "@/components/ui/modal";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

export default function HelpButton() {
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    // Check if this is the first visit
    const hasSeenHelp = localStorage.getItem("compass-has-seen-help");
    if (!hasSeenHelp) {
      setIsOpen(true);
      // Set flag AFTER a delay to allow ExperimentContext to check first
      setTimeout(() => {
        localStorage.setItem("compass-has-seen-help", "true");
      }, 100);
    }
  }, []);

  const handleClick = (e: React.MouseEvent) => {
    // Dev secret: Shift+Click to reset localStorage and refresh
    if (e.shiftKey) {
      localStorage.clear();
      window.location.reload();
      return;
    }
    setIsOpen(true);
  };

  return (
    <>
      <TooltipProvider>
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              onClick={handleClick}
              className="flex flex-col sm:flex-row items-center gap-0 sm:gap-1.5 rounded-md border border-gray-300 bg-white px-2 py-1.5 sm:px-3 sm:py-2 text-sm font-medium text-gray-700 shadow-sm hover:bg-gray-50 hover:shadow focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 transition-shadow"
            >
              <HelpCircle className="h-4 w-4" />
              <span className="text-[8px] leading-none uppercase font-semibold tracking-wide sm:text-sm sm:normal-case sm:font-medium sm:tracking-normal sm:leading-normal">Help</span>
            </button>
          </TooltipTrigger>
          <TooltipContent>
            <p>View help and documentation</p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <Modal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        title="Help & Documentation"
        description="Learn how to use Compass to run experiments"
        maxWidth="2xl"
        fullScreenMobile
      >
        <div className="p-4 sm:p-6">
          <Accordion type="single" collapsible className="w-full space-y-2">
            <AccordionItem value="version" className="border border-blue-200 rounded-lg px-4 sm:px-6 bg-blue-50 hover:bg-blue-100 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-blue-900 hover:text-blue-900 hover:no-underline [&[data-state=open]>svg]:text-blue-600">
                Version 0.5.0-alpha — Visual Prototype
              </AccordionTrigger>
              <AccordionContent className="text-sm text-blue-800 leading-relaxed pb-3 sm:pb-4">
                This is an early prototype that serves as a design proposal and evaluation tool for the experiment configuration data format. Running of actual experiments is not implemented yet.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-1" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                What is Compass?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-3">
                  Compass is an internal tool that lets anyone in the company run LLM experiments without touching Python or installing anything.
                </p>
                <p className="font-bold mb-1">It uses two LLMs:</p>
                <ul className="ml-4 space-y-1 list-disc mb-3">
                  <li><strong>One being experimented on</strong> - receives prompts, responds, and calls tools</li>
                  <li><strong>One simulating tools</strong> - generates realistic tool outputs, so tools don&apos;t need to be implemented or sandboxed</li>
                </ul>
                <p className="font-bold mb-1">What you can do:</p>
                <ul className="ml-4 space-y-1 list-disc">
                  <li><strong>Create and edit experiment configuration .yaml files</strong> - [Implemented]</li>
                  <li><strong>Run the experiment and observe progress through many iterations</strong> - [Pending]</li>
                  <li><strong>Explore the data collected (responses, tool calls, etc.)</strong> - [Pending]</li>
                </ul>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-examples" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                Can I see any examples?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-2">Yes!</p>
                <p>Click the Library button at the top of the interface to browse example experiments including chess cheating detection, shutdown resistance, and more.</p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-2" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                What are steps?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                Steps are different messages sent in succession to the model. Each step can reference previous
                responses using special tokens like <code className="bg-gray-100 px-1 rounded text-sm">{'{{ last_response }}'}</code> and
                <code className="bg-gray-100 px-1 rounded text-sm ml-1">{'{{ previous_tool_calls }}'}</code>. This lets you
                build multi-turn experiments that test how models behave over extended interactions.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-3" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                How do tools work?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-2">Tools have three components:</p>
                <ol className="ml-4 space-y-1 list-decimal mb-3">
                  <li><strong>Input Value:</strong> The model provides a single typed input value (e.g., boolean, string, integer)</li>
                  <li><strong>LLM Simulation Layer:</strong> A separate LLM generates what the tool would return</li>
                  <li><strong>Output Value:</strong> Returns a single typed value that is returned to the model being tested</li>
                </ol>
                <p>This architecture allows realistic tool behavior without actually implementing software tools or tools that modify real systems.</p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-4" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                How does tool simulation work?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-3">
                  Tools are simulated by invoking a separate LLM that generates what the tool call would return
                  if it were real. For example, if a model calls <code className="bg-gray-100 px-1 rounded text-sm">exec(&quot;ls /tmp&quot;)</code>,
                  a separate LLM simulates the file system state and returns a realistic directory listing.
                  This lets you test model behavior without actual system access.
                </p>
                <p className="font-bold mb-1">State Persistence:</p>
                <p className="mb-2">
                  Tools maintain state across calls using the <code className="bg-gray-100 px-1 rounded text-sm">{'{{tool_notes}}'}</code> and{' '}
                  <code className="bg-gray-100 px-1 rounded text-sm">{'{{record_tool_note}}'}</code> special tokens. When a tool needs to persist information,
                  the simulator calls <code className="bg-gray-100 px-1 rounded text-sm">{'{{record_tool_note}}'}</code> to save observations.
                  Later tool calls can read <code className="bg-gray-100 px-1 rounded text-sm">{'{{tool_notes}}'}</code> to understand the current state.
                </p>
                <p className="text-xs sm:text-sm bg-gray-50 p-2 rounded border border-gray-200 text-gray-700">
                  <strong>Example:</strong> A simulated Linux shell records side effects like &quot;started daemon on port 8080&quot; using{' '}
                  <code className="bg-gray-100 px-1 rounded">{'{{record_tool_note}}'}</code>. When the model later tries to start another process
                  on port 8080, the simulator reads <code className="bg-gray-100 px-1 rounded">{'{{tool_notes}}'}</code>, sees the port is already
                  in use, and returns an error.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-yaml" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                Why YAML files?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-2">YAML configuration files enable data-driven experiments that offer several key advantages:</p>
                <ul className="ml-4 space-y-1 list-disc mb-2">
                  <li><strong>No code changes needed</strong> - Modify experiments without touching Python code</li>
                  <li><strong>Easy sharing</strong> - Send configurations to teammates or collaborators</li>
                  <li><strong>Version control</strong> - Track experiment evolution in Git alongside code</li>
                  <li><strong>Structured storage</strong> - Store in databases or file systems for organization</li>
                  <li><strong>Cross-platform</strong> - Parse and run experiments in different implementations</li>
                </ul>
                <p className="mb-2">This separation of experiment definition from execution code makes iteration faster and collaboration simpler.</p>
                <p>YAML files are more human-editable versions of JSON files and can be easily converted back and forth.</p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-5" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                How do I build complex behavior with Compass?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-2">You can create sophisticated experiments by combining:</p>
                <ul className="ml-4 space-y-1 list-disc">
                  <li><strong>Tool calls:</strong> Give models access to simulated tools like Linux shells, file systems, or custom APIs</li>
                  <li><strong>Multi-step sequences:</strong> Chain multiple prompts together to test behavior over extended interactions</li>
                  <li><strong>Special tokens:</strong> Reference previous responses, tool calls, scores, and state using tokens like{' '}
                    <code className="bg-gray-100 px-1 rounded text-xs">{'{{ last_response }}'}</code>,{' '}
                    <code className="bg-gray-100 px-1 rounded text-xs">{'{{ previous_tool_calls }}'}</code>,{' '}
                    <code className="bg-gray-100 px-1 rounded text-xs">{'{{ tool_notes }}'}</code>, and{' '}
                    <code className="bg-gray-100 px-1 rounded text-xs">{'{{ tool_call_count }}'}</code>
                  </li>
                  <li><strong>Liquid templating:</strong> Use Liquid template syntax for conditional logic and text transformations</li>
                  <li><strong>Custom <code className="bg-gray-100 px-1 rounded text-xs">prompt</code> filter:</strong> Transform text dynamically by invoking an LLM within your templates</li>
                </ul>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-6" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                How do I dynamically modify content?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                <p className="mb-2">
                  Liquid is a templating language that lets you add logic and transformations to your prompts. Use{' '}
                  <code className="bg-gray-100 px-1 rounded text-xs">{'{{ variable }}'}</code> to insert values,{' '}
                  <code className="bg-gray-100 px-1 rounded text-xs">{'{% if condition %}'}</code> for conditional logic, and{' '}
                  <code className="bg-gray-100 px-1 rounded text-xs">{'{% assign %}'}</code> to create variables. You can filter tool calls
                  by name using <code className="bg-gray-100 px-1 rounded text-xs">where</code> and get the latest with{' '}
                  <code className="bg-gray-100 px-1 rounded text-xs">last</code>.
                </p>
                <div className="text-xs sm:text-sm bg-gray-50 p-2 rounded border border-gray-200 mb-2 font-mono text-gray-700">
                  {'{% assign last_chess = previous_tool_calls | where: \'name\', \'make_chess_move\' | last %}'}<br />
                  {'Opponent\'s move: {{ last_chess.input | prompt: \'Generate a response move\' }}'}
                </div>
                <p className="mb-3">
                  <a href="https://shopify.github.io/liquid/" target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:text-blue-800">
                    Learn more about Liquid
                  </a>
                </p>
                <p className="font-bold mb-1">Custom <code className="bg-gray-100 px-1 rounded text-xs">prompt</code> Filter:</p>
                <p className="text-sm">
                  The <code className="bg-gray-100 px-1 rounded">prompt</code> filter transforms text by invoking an LLM with a specified instruction.
                  Use it like: <code className="bg-gray-100 px-1 rounded">{'{{ some_text | prompt: "Your transformation instruction here" }}'}</code>.
                  This is useful for generating dynamic content based on previous responses or tool outputs—for example, generating opponent moves
                  in a chess game or creating counter-arguments to test reasoning.
                </p>
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-7" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                Can I generate Compass experiments using AI?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                Yes! Click &quot;New&quot; and copy the provided prompt, then paste it into your favorite LLM. It will be given enough context to generate a <code className="bg-gray-100 px-1 rounded text-sm">.yaml</code> file based on your experiment idea.
              </AccordionContent>
            </AccordionItem>

            <AccordionItem value="item-9" className="border border-gray-200 rounded-lg px-4 sm:px-6 bg-white hover:bg-gray-50 transition-colors">
              <AccordionTrigger className="py-3 sm:py-4 text-base font-medium text-gray-700 hover:text-gray-900 hover:no-underline">
                Can I run multiple parallel runs simultaneously?
              </AccordionTrigger>
              <AccordionContent className="text-sm sm:text-base text-gray-700 leading-relaxed pb-3 sm:pb-4">
                To manage token costs, you can run multiple models in parallel, but each model runs sequentially (one iteration at a time). This means you can compare different models simultaneously, but not run multiple parallel executions of the same model.
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </div>
      </Modal>
    </>
  );
}
