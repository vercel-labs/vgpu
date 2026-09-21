/**
 * Ambient shape for the optional `@vgpu/adapter-node` peer dependency, declared globally (this file
 * has no top-level import/export, so `declare module` here creates a brand-new ambient module
 * instead of augmenting one — no real project reference to `@vgpu/adapter-node` is needed).
 *
 * `validation-device.ts` dynamically imports `@vgpu/adapter-node` using a *literal* specifier so
 * `tsc` emits it verbatim (no `__rewriteRelativeImportExtension` wrapper, which bundlers' static
 * analysis — and Next's build-dependency cache scanner — cannot see through). Resolving that literal
 * specifier's real types would need a `wgsl -> adapter-node` project reference, which combined with
 * `adapter-node -> core -> wgsl` forms a cycle `tsc -b` rejects. This project's `paths` mapping
 * directs type resolution here: an ambient declaration alone does not stop TypeScript traversing
 * an installed adapter's declarations. The mapping does not change the emitted runtime import.
 * Keep in sync with `AdapterNodeModule` in validation-device.ts.
 */
declare module "@vgpu/adapter-node" {
  export function createNodeAdapter(): {
    requestDevice(): Promise<{ readonly gpu: GPUDevice }>;
  };
}
