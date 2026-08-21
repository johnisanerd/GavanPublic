"use client";

import { useExperiment } from "@/lib/context/ExperimentContext";

export default function IterationsSlider() {
  const { form } = useExperiment();
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const currentValue = watch("iterations");

  const POWERS_OF_TWO = [1, 2, 4, 8, 16, 32, 64, 128];

  // Find nearest power of 2
  const findNearestPowerOfTwo = (value: number): number => {
    return POWERS_OF_TWO.reduce((prev, curr) =>
      Math.abs(curr - value) < Math.abs(prev - value) ? curr : prev
    );
  };

  // Convert slider position (0-7) to power of 2
  const sliderToValue = (sliderPos: number): number => {
    return POWERS_OF_TWO[Math.round(sliderPos)];
  };

  // Convert value to slider position
  const valueToSlider = (value: number): number => {
    const nearestPower = findNearestPowerOfTwo(value);
    return POWERS_OF_TWO.indexOf(nearestPower);
  };

  const handleSliderChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const sliderPos = parseInt(e.target.value);
    const value = sliderToValue(sliderPos);
    setValue("iterations", value, { shouldValidate: true });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseInt(e.target.value) || 1;
    const clamped = Math.max(1, Math.min(128, value));
    setValue("iterations", clamped, { shouldValidate: true });
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 select-none">
        Iterations <span className="text-red-500">*</span>
      </label>
      <p className="mt-1 text-sm text-gray-500 select-none">
        Number of times to run (1-128)
      </p>

      <div className="mt-3 flex items-center gap-4">
        <input
          type="range"
          min="0"
          max="7"
          step="1"
          value={valueToSlider(currentValue)}
          onChange={handleSliderChange}
          className="h-2 sm:h-2 flex-1 cursor-pointer appearance-none rounded-lg bg-gray-200 accent-blue-600 [&::-webkit-slider-thumb]:h-6 [&::-webkit-slider-thumb]:w-6 sm:[&::-webkit-slider-thumb]:h-4 sm:[&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-blue-600 [&::-moz-range-thumb]:h-6 [&::-moz-range-thumb]:w-6 sm:[&::-moz-range-thumb]:h-4 sm:[&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:appearance-none [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:bg-blue-600 [&::-moz-range-thumb]:border-0"
        />
        <input
          type="number"
          min={1}
          max={128}
          value={currentValue}
          onChange={handleInputChange}
          className="w-20 rounded-md border border-gray-300 px-3 py-1.5 text-center text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {errors.iterations && (
        <p className="mt-1 text-sm text-red-600 select-none">
          {errors.iterations.message}
        </p>
      )}
    </div>
  );
}
