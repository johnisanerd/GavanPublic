import Ajv, { ErrorObject } from "ajv";
import addFormats from "ajv-formats";
import { CompassExperiment } from "@/lib/types/compass-experiment";
import schema from "@/lib/schemas/compass-experiment.schema.json";

const ajv = new Ajv({
  allErrors: true,
  verbose: true,
  strict: false,
});

addFormats(ajv);

const validateExperiment = ajv.compile(schema);

export interface ValidationError {
  path: string;
  message: string;
}

export function formatValidationErrors(
  errors: ErrorObject[] | null | undefined
): ValidationError[] {
  if (!errors) return [];

  return errors.map((error) => {
    const path = error.instancePath || "/";
    let message = error.message || "Invalid value";

    // Improve error messages for better readability
    switch (error.keyword) {
      case "required":
        message = `Missing required field: ${error.params.missingProperty}`;
        break;
      case "type":
        message = `Expected ${error.params.type}, but got ${typeof error.data}`;
        break;
      case "minItems":
        message = `Must have at least ${error.params.limit} item(s)`;
        break;
      case "minimum":
        message = `Must be at least ${error.params.limit}`;
        break;
      case "maximum":
        message = `Must be at most ${error.params.limit}`;
        break;
      case "pattern":
        message = `Does not match required pattern`;
        break;
      case "enum":
        message = `Must be one of: ${error.params.allowedValues.join(", ")}`;
        break;
      case "const":
        message = `Must be exactly: ${error.params.allowedValue}`;
        break;
      case "minLength":
        message = `Must be at least ${error.params.limit} character(s)`;
        break;
    }

    return {
      path,
      message,
    };
  });
}

export function validateCompassExperiment(
  data: unknown
): { valid: true; data: CompassExperiment } | { valid: false; errors: ValidationError[] } {
  const valid = validateExperiment(data);

  if (valid) {
    return {
      valid: true,
      data: data as unknown as CompassExperiment,
    };
  }

  return {
    valid: false,
    errors: formatValidationErrors(validateExperiment.errors),
  };
}
