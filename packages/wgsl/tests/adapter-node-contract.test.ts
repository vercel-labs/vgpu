import { expect, test } from "vitest";

/**
 * `validation-device.ts` cannot `import type` from `@vgpu/adapter-node` (that would form the
 * wgsl -> adapter-node -> core -> wgsl cycle `tsc -b` rejects), so it describes the adapter's shape
 * with a local structural type and the device tests mock that shape. Nothing would notice if
 * adapter-node's real API drifted away from it — except this test, which imports the real module.
 *
 * Deliberately device-free: acquiring an adapter object and reading `requestDevice` costs no GPU, so
 * this runs in ordinary CI rather than only behind the Docker/device gate.
 */
test("@vgpu/adapter-node still matches the shape validation-device.ts assumes", async () => {
  // Indirect specifier, exactly as validation-device.ts does it: keeps TypeScript from resolving
  // adapter-node's types here (its .d.ts is not built yet when wgsl compiles) and keeps bundlers
  // from following the import.
  const specifier = "@vgpu/adapter-node";
  const adapterNode = (await import(specifier)) as { createNodeAdapter?: () => { requestDevice?: unknown } };

  expect(typeof adapterNode.createNodeAdapter).toBe("function");
  const adapter = adapterNode.createNodeAdapter!();
  expect(typeof adapter.requestDevice).toBe("function");
});
