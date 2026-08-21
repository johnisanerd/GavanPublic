"use client";

import { useState } from "react";
import { Variable, Play, HelpCircle, ExternalLink, ChevronDown, ChevronUp } from "lucide-react";

interface Token {
  label: string;
  value: string;
  description?: string;
  type?: "variable" | "function";
}

interface TokenChipsProps {
  tokens: Token[];
  onInsert: (value: string) => void;
  collapsible?: boolean;
  label?: string;
}

export default function TokenChips({ tokens, onInsert, collapsible = false, label = "Variables & Tools" }: TokenChipsProps) {
  const [showHelp, setShowHelp] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(true);

  // Sort tokens by type (variables first), then alphabetically by label
  const sortedTokens = [...tokens].sort((a, b) => {
    const typeA = a.type || "variable";
    const typeB = b.type || "variable";

    if (typeA !== typeB) {
      return typeA === "variable" ? -1 : 1;
    }

    return a.label.localeCompare(b.label);
  });

  const getChipStyles = (type?: "variable" | "function") => {
    if (type === "function") {
      return "rounded-md border border-teal-200 bg-teal-50 px-2 py-1 text-xs font-medium text-teal-700 hover:bg-teal-100 focus:outline-none focus:ring-2 focus:ring-teal-500 focus:ring-offset-1 select-none flex items-center gap-1";
    }
    // Default to blue for variables
    return "rounded-md border border-blue-200 bg-blue-50 px-2 py-1 text-xs font-medium text-blue-700 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-1 select-none flex items-center gap-1";
  };

  const getIcon = (type?: "variable" | "function") => {
    if (type === "function") {
      return <Play className="h-3 w-3" />;
    }
    return <Variable className="h-3 w-3" />;
  };

  if (collapsible) {
    return (
      <>
        <div className="rounded-lg border border-gray-200 bg-gray-50/50">
          <div
            className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-gray-100/50 transition-colors"
            onClick={() => setIsCollapsed(!isCollapsed)}
          >
            <span className="text-xs text-gray-500 select-none flex-1">
              {label}
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setShowHelp(true);
              }}
              className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className="text-gray-400"
            >
              {isCollapsed ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronUp className="h-4 w-4" />
              )}
            </button>
          </div>

          {!isCollapsed && (
            <div className="px-3 pb-3">
              <div className="flex flex-wrap gap-1.5">
                {sortedTokens.map((token) => (
                  <button
                    key={token.value}
                    type="button"
                    onClick={() => onInsert(token.value)}
                    className={getChipStyles(token.type)}
                        >
                    {getIcon(token.type)}
                    {token.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        {showHelp && renderHelpModal()}
      </>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex flex-wrap gap-1.5 flex-1">
          {sortedTokens.map((token) => (
            <button
              key={token.value}
              type="button"
              onClick={() => onInsert(token.value)}
              className={getChipStyles(token.type)}
            >
              {getIcon(token.type)}
              {token.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowHelp(true)}
          className="rounded-md p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
          title="View token documentation"
        >
          <HelpCircle className="h-4 w-4" />
        </button>
      </div>
      {showHelp && renderHelpModal()}
    </>
  );

  function renderHelpModal() {
    return (
      <div
        className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4"
        onClick={() => setShowHelp(false)}
      >
          <div
            className="bg-white rounded-lg shadow-xl max-w-2xl w-full max-h-[80vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              <h2 className="text-xl font-semibold text-gray-900 mb-4">
                Token Documentation
              </h2>

              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">
                    Available Tokens
                  </h3>
                  <div className="space-y-2">
                    {sortedTokens
                      .filter((token) => !token.value.includes("|") && !token.value.includes("{%"))
                      .map((token) => (
                        <div key={token.value} className="flex items-start gap-2">
                          <div className="mt-0.5">{getIcon(token.type)}</div>
                          <div className="flex-1 min-w-0">
                            <div className="font-mono text-xs text-gray-900 break-all">
                              {token.value}
                            </div>
                            {token.description && (
                              <div className="text-xs text-gray-600 mt-0.5">
                                {token.description}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">
                    Custom Filters
                  </h3>
                  <div className="space-y-2 mb-3">
                    <div className="flex items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="font-mono text-xs text-gray-900 break-all">
                          {'{{ value | prompt: "your prompt here" }}'}
                        </div>
                        <div className="text-xs text-gray-600 mt-0.5">
                          Transform a value using an LLM prompt
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="pt-4 border-t border-gray-200">
                  <h3 className="text-sm font-semibold text-gray-700 mb-2">
                    Liquid Template Language
                  </h3>
                  <p className="text-sm text-gray-600 mb-2">
                    Prompts support the Liquid template language with filters,
                    conditionals, and loops.
                  </p>
                  <a
                    href="https://liquidjs.com/tutorials/intro-to-liquid.html"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:text-blue-700 font-medium"
                  >
                    View Liquid Documentation
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </div>
              </div>

              <div className="mt-6 flex justify-end">
                <button
                  type="button"
                  onClick={() => setShowHelp(false)}
                  className="px-4 py-2 bg-gray-100 hover:bg-gray-200 text-gray-700 rounded-lg text-sm font-medium transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
    );
  }
}
