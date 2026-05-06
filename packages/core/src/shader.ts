import type { ResolvedShader } from "@vgpu/wgsl";

export type ShaderInput = ResolvedShader | string;

export class Shader {
  constructor(readonly gpu: GPUShaderModule, readonly resolved: ResolvedShader) {}

  dispose(): void {}

  get source(): ResolvedShader["source"] {
    return this.resolved.source;
  }

  get entryPoints(): ResolvedShader["entryPoints"] {
    return this.resolved.entryPoints;
  }

  get stats(): ResolvedShader["stats"] {
    return this.resolved.stats;
  }
}
