"use client";

import ModelSelector from "./ModelSelector";
import IterationsSlider from "./IterationsSlider";

export default function ModelsAndIterations() {
  return (
    <div className="mb-6 grid gap-6 lg:grid-cols-[1fr_auto] lg:gap-8">
      <ModelSelector />
      <div className="lg:w-80">
        <IterationsSlider />
      </div>
    </div>
  );
}
