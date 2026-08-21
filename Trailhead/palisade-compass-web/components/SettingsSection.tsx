"use client";

import ModelSelector from "./ModelSelector";
import IterationsSlider from "./IterationsSlider";

export default function SettingsSection() {
  return (
    <div>
      <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
        <div className="grid gap-6 lg:grid-cols-[1fr_auto] lg:gap-8">
          <ModelSelector />
          <div className="lg:w-80">
            <IterationsSlider />
          </div>
        </div>
      </div>
    </div>
  );
}
