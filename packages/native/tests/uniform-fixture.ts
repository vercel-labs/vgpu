import type { MetalPackageInput } from "../src/index.ts";

export function uniformPackageInput(): MetalPackageInput {
  return {
    moduleName: "AppShaders",
    library: new Uint8Array([1, 2, 3]),
    programs: [{
      name: "Gradient",
      functions: { fragment: "fragment_main" },
      uniforms: [{
        name: "params",
        typeName: "Params",
        byteCount: 32,
        alignment: 16,
        members: [
          { name: "accent", type: "vec3f", offset: 0 },
          { name: "gain", type: "f32", offset: 12 },
          { name: "phase", type: "vec2f", offset: 16 },
        ],
      }],
    }],
  };
}
