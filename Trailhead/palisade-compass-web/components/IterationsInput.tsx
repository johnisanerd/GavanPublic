"use client";

import { useExperiment } from "@/lib/context/ExperimentContext";

const POWER_OF_TWO_OPTIONS = [1, 2, 4, 8, 16, 32, 64, 128];

export default function IterationsInput() {
  const { form } = useExperiment();
  const {
    register,
    watch,
    setValue,
    formState: { errors },
  } = form;

  const currentValue = watch("iterations");

  const handlePowerOfTwoClick = (value: number) => {
    setValue("iterations", value, { shouldValidate: true });
  };

  return (
    <div className="mb-6">
      <label
        htmlFor="iterations"
        className="block text-sm font-medium text-gray-700"
      >
        Iterations <span className="text-red-500">*</span>
      </label>
      <p className="mt-1 text-sm text-gray-500">
        Number of times to run the experiment (1-128)
      </p>

      <div className="mt-2 flex gap-2">
        <input
          id="iterations"
          type="number"
          min={1}
          max={128}
          {...register("iterations", {
            required: "Iterations is required",
            min: {
              value: 1,
              message: "Minimum is 1",
            },
            max: {
              value: 128,
              message: "Maximum is 128",
            },
            valueAsNumber: true,
          })}
          className="block w-32 rounded-md border border-gray-300 px-3 py-2 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />

        <div className="flex flex-1 flex-wrap gap-1.5">
          {POWER_OF_TWO_OPTIONS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => handlePowerOfTwoClick(value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                currentValue === value
                  ? "bg-blue-600 text-white"
                  : "border border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {value}
            </button>
          ))}
        </div>
      </div>

      {errors.iterations && (
        <p className="mt-1 text-sm text-red-600">
          {errors.iterations.message}
        </p>
      )}
    </div>
  );
}
