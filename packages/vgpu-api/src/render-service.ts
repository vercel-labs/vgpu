/**
 * The single lazy render service of a `Gpu`: bind groups, pipelines, shader modules,
 * pipeline layouts and samplers.
 *
 * Every render-family free function (draw, effect, and later scene views) resolves it through
 * the same token, so they share one cache set and one identity — no duplicated pipeline stores.
 * It is created on first render use and torn down in the kernel's `service` phase, after
 * schedulers and resources, before the device.
 */
import { createBindGroupCache, type BindGroupCache } from "./bind-cache.ts";
import { createSamplerCache } from "./sampler.ts";
import { createPipelineLayoutCache, createPipelineStore, createShaderModuleCache, type PipelineLayoutCache, type PipelineStore, type ShaderModuleCache } from "./pipeline-store.ts";
import { serviceToken, type Kernel } from "./kernel.ts";

export interface RenderService {
  readonly binds: BindGroupCache;
  readonly pipelines: PipelineStore;
  readonly shaderModules: ShaderModuleCache;
  readonly pipelineLayouts: PipelineLayoutCache;
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
}

export const renderServiceToken = serviceToken<RenderService>("render-service");

/** Lazily creates the render service of this kernel; repeated calls return the same instance. */
export function renderService(kernel: Kernel): RenderService {
  return kernel.service(renderServiceToken, createRenderService);
}

function createRenderService(kernel: Kernel): RenderService {
  const device = kernel.device;
  const binds = createBindGroupCache();
  const pipelines = createPipelineStore(device, {
    errorSink: (error) => kernel.reportError(error),
    registerSettledSource: (source) => kernel.registerSettledSource(source),
  });
  const shaderModules = createShaderModuleCache(device);
  const pipelineLayouts = createPipelineLayoutCache(device);
  const samplers = createSamplerCache(device);
  kernel.own("service", () => {
    pipelines.dispose();
    shaderModules.dispose();
    pipelineLayouts.dispose();
    binds.dispose();
  });
  return { binds, pipelines, shaderModules, pipelineLayouts, sampler: (desc) => samplers.sampler(desc) };
}
