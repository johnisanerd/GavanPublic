"use client";

import { useRef } from "react";
import { Compass } from "lucide-react";
import ImportExportButtons from "./ImportExportButtons";
import NewExperimentButton from "./NewExperimentButton";
import ExamplesButton from "./ExamplesButton";
import HelpButton from "./HelpButton";

export default function Header() {
  const openImportRef = useRef<(() => void) | null>(null);

  return (
    <header className="border-b border-gray-200 bg-white/70 backdrop-blur-md supports-[backdrop-filter]:bg-white/70 px-4 py-2 sm:px-6 sm:py-3">
      <div className="mx-auto max-w-5xl flex items-center justify-between">
        <div className="flex items-center gap-1.5 sm:gap-3 min-w-0">
          <Compass className="h-4 w-4 sm:h-6 sm:w-6 text-gray-900 flex-shrink-0" />
          <h1 className="text-base sm:text-2xl font-semibold text-gray-900 select-none tracking-tight truncate">
            Compass
          </h1>
        </div>
        <div className="flex gap-1.5 flex-shrink-0">
          <ExamplesButton />
          <NewExperimentButton onOpenImport={() => openImportRef.current?.()} />
          <ImportExportButtons onOpenImportRef={openImportRef} />
          <HelpButton />
        </div>
      </div>
    </header>
  );
}
