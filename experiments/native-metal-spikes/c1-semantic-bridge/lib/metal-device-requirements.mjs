export class MetalDeviceRequirementsError extends Error {
  constructor(message) {
    super(`VGPU-C1-METAL-REQUIREMENTS: ${message}`);
    this.name = "MetalDeviceRequirementsError";
    this.code = "VGPU-C1-METAL-REQUIREMENTS";
  }
}

/**
 * Projects the current semantic-program subset into program-local Metal
 * device requirements. WGSL language features are build-time inputs and do
 * not participate in this projection.
 */
export function projectMetalDeviceRequirements(program) {
  if (
    program === null ||
    typeof program !== "object" ||
    Array.isArray(program)
  ) {
    fail("semantic program must be an object");
  }

  const capabilities = program.capabilities;
  if (
    capabilities === null ||
    typeof capabilities !== "object" ||
    Array.isArray(capabilities) ||
    !Array.isArray(capabilities.features)
  ) {
    fail("semantic program capabilities.features must be an array");
  }
  if (capabilities.features.length !== 0) {
    fail("semantic execution features are not projected by this Metal slice");
  }

  if (!Array.isArray(program.bindings)) {
    fail("semantic program bindings must be an array");
  }
  for (const [index, binding] of program.bindings.entries()) {
    if (
      binding === null ||
      typeof binding !== "object" ||
      Array.isArray(binding) ||
      typeof binding.kind !== "string"
    ) {
      fail(`semantic binding at index ${index} is malformed`);
    }
    if (binding.kind === "storage-texture") {
      fail(
        `semantic binding at index ${index} requires storage-texture format projection`
      );
    }
    if (!["buffer", "texture", "sampler"].includes(binding.kind)) {
      fail(
        `semantic binding at index ${index} has unsupported kind ${JSON.stringify(
          binding.kind
        )}`
      );
    }
  }

  return deepFreeze({ features: [], limits: [], formats: [] });
}

function fail(message) {
  throw new MetalDeviceRequirementsError(message);
}

function deepFreeze(value) {
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
