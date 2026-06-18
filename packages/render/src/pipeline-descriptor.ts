import { Shader, VGPUError } from "@vgpu/core";

export type RenderPipelineShaderInput = Shader | GPUShaderModule;

export interface RenderPipelineStageOptions {
  /** VGPU Shader or raw GPUShaderModule for this stage. Defaults to RenderPipelineOptions.shader. */
  readonly shader?: RenderPipelineShaderInput;
  /** Descriptor-like alias for shader. */
  readonly module?: RenderPipelineShaderInput;
  /** Entry-point name. Kept for backwards compatibility with the first render helper API. */
  readonly entry?: string;
  /** Descriptor-like entry-point name. */
  readonly entryPoint?: string;
  readonly constants?: Record<string, GPUPipelineConstantValue>;
}

export interface RenderPipelineVertexOptions extends RenderPipelineStageOptions {
  readonly buffers?: readonly (GPUVertexBufferLayout | null)[];
}

export interface RenderPipelineFragmentOptions extends RenderPipelineStageOptions {
  readonly targets: readonly (GPUColorTargetState | null)[];
}

export interface RenderPipelineOptions {
  /** Optional shared shader module used by vertex/fragment stages that do not provide their own module. */
  readonly shader?: RenderPipelineShaderInput;
  readonly vertex: RenderPipelineVertexOptions;
  readonly fragment?: RenderPipelineFragmentOptions;
  readonly primitive?: GPUPrimitiveState;
  readonly depthStencil?: GPUDepthStencilState;
  readonly multisample?: GPUMultisampleState;
  readonly layout?: GPUPipelineLayout | "auto";
  readonly label?: string;
  /** createRenderPipelineAsync fallback when GPUDevice.createRenderPipelineAsync is unavailable. Defaults to "sync". */
  readonly fallback?: RenderPipelineAsyncFallback;
}

export type RenderPipelineAsyncFallback = "sync" | "throw";

export function toRenderPipelineDescriptor(opts: RenderPipelineOptions): GPURenderPipelineDescriptor {
  const descriptor: GPURenderPipelineDescriptor = {
    label: opts.label,
    layout: opts.layout ?? "auto",
    vertex: {
      module: stageModule(opts.vertex, opts.shader, "vertex"),
      entryPoint: stageEntryPoint(opts.vertex),
      constants: opts.vertex.constants,
      buffers: opts.vertex.buffers ? [...opts.vertex.buffers] : undefined,
    },
    primitive: opts.primitive,
    depthStencil: opts.depthStencil,
    multisample: opts.multisample,
  };

  if (opts.fragment) {
    descriptor.fragment = {
      module: stageModule(opts.fragment, opts.shader, "fragment"),
      entryPoint: stageEntryPoint(opts.fragment),
      constants: opts.fragment.constants,
      targets: [...opts.fragment.targets],
    };
  }

  return descriptor;
}

function stageModule(
  stage: RenderPipelineStageOptions,
  fallback: RenderPipelineShaderInput | undefined,
  stageName: "vertex" | "fragment",
): GPUShaderModule {
  const module = stage.module ?? stage.shader ?? fallback;
  if (!module) {
    throw new VGPUError({
      code: "VGPU-RENDER-PIPELINE-MISSING-SHADER",
      message: `Missing shader module for ${stageName} stage.`,
      fix: "Pass options.shader for a shared module or pass vertex/fragment module or shader.",
      where: `createRenderPipeline.${stageName}`,
    });
  }
  return isShader(module) ? module.gpu : module;
}

function stageEntryPoint(stage: RenderPipelineStageOptions): string | undefined {
  return stage.entryPoint ?? stage.entry;
}

function isShader(input: RenderPipelineShaderInput): input is Shader {
  return input instanceof Shader;
}
