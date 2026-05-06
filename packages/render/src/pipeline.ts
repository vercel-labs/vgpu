import type { Device, Shader } from "@vgpu/core";

export interface RenderPipelineOptions {
  readonly shader: Shader;
  readonly vertex: { readonly entry: string };
  readonly fragment: { readonly entry: string; readonly targets: readonly GPUColorTargetState[] };
  readonly primitive?: GPUPrimitiveState;
  readonly layout?: GPUPipelineLayout | "auto";
  readonly label?: string;
}

export function createRenderPipeline(device: Device, opts: RenderPipelineOptions): GPURenderPipeline {
  return device.gpu.createRenderPipeline({
    label: opts.label,
    layout: opts.layout ?? "auto",
    vertex: { module: opts.shader.gpu, entryPoint: opts.vertex.entry },
    fragment: { module: opts.shader.gpu, entryPoint: opts.fragment.entry, targets: [...opts.fragment.targets] },
    primitive: opts.primitive,
  });
}
