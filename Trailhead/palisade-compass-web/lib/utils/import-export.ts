import yaml from "js-yaml";
import { v4 as uuidv4 } from "uuid";
import { CompassExperiment } from "@/lib/types/compass-experiment";
import { validateCompassExperiment } from "@/lib/validation/experiment-validator";

export interface ImportResult {
  success: boolean;
  data?: CompassExperiment;
  errors?: string[];
}

export function stampIdIfMissing(
  experiment: CompassExperiment
): CompassExperiment {
  if (!experiment.id) {
    return {
      ...experiment,
      id: uuidv4(),
    };
  }
  return experiment;
}

export function importExperiment(content: string, format: "yaml" | "json"): ImportResult {
  try {
    let parsed: unknown;

    if (format === "yaml") {
      parsed = yaml.load(content);
    } else {
      parsed = JSON.parse(content);
    }

    const validation = validateCompassExperiment(parsed);

    if (!validation.valid) {
      return {
        success: false,
        errors: validation.errors.map(
          (err) => `${err.path}: ${err.message}`
        ),
      };
    }

    const experimentWithId = stampIdIfMissing(validation.data);

    return {
      success: true,
      data: experimentWithId,
    };
  } catch (error) {
    return {
      success: false,
      errors: [
        `Failed to parse ${format.toUpperCase()}: ${error instanceof Error ? error.message : "Unknown error"}`,
      ],
    };
  }
}

export function exportExperiment(
  experiment: CompassExperiment,
  format: "yaml" | "json"
): string {
  const experimentWithId = stampIdIfMissing(experiment);

  if (format === "yaml") {
    return yaml.dump(experimentWithId, {
      indent: 2,
      lineWidth: -1,
    });
  } else {
    return JSON.stringify(experimentWithId, null, 2);
  }
}

export function downloadExperiment(
  experiment: CompassExperiment,
  format: "yaml" | "json"
) {
  const content = exportExperiment(experiment, format);
  const blob = new Blob([content], {
    type: format === "yaml" ? "text/yaml" : "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const filename = `${experiment.title || "experiment"}.${format}`;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
