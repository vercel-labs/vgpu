import { pullExample } from "./pull.js";
import { createExamplesService } from "./service.js";

export function createLocalExamplesService(options) {
  if (typeof options?.downloadRoot !== "string" || options.downloadRoot.length === 0) {
    throw new TypeError("Local examples service requires an explicit download root");
  }
  return createExamplesService({
    ...options,
    downloadExample: pullExample,
  });
}
