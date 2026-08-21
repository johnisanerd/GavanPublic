export const dynamic = "force-dynamic";

// Analysis → Results: placeholder until scoring/analysis lands. A faded,
// diagonal "Not implemented yet" watermark.
export default function AnalysisPage() {
  return (
    <div className="flex flex-col gap-6 p-4 sm:p-6">
      <div>
        <p className="text-muted-foreground font-mono text-xs uppercase tracking-wide">
          Analysis
        </p>
        <h1 className="mt-1 text-2xl font-normal tracking-tight">Results</h1>
      </div>

      <div className="relative flex min-h-[50vh] items-center justify-center overflow-hidden rounded-lg border">
        <span className="text-muted-foreground/15 -rotate-12 select-none text-5xl font-semibold tracking-tight sm:text-7xl">
          Not implemented yet
        </span>
      </div>
    </div>
  );
}
