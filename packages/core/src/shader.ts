import type { ResolvedShader } from "@vgpu/wgsl";

export type ShaderInput = ResolvedShader | string;

export class Shader {
  constructor(readonly gpu: GPUShaderModule, readonly resolved: ResolvedShader) {}

  dispose(): void {}

  get kind(): ResolvedShader["kind"] {
    return this.resolved.kind;
  }

  get source(): ResolvedShader["source"] {
    return this.resolved.source;
  }

  get code(): string {
    return this.resolved.wgsl;
  }

  get entryPoints(): ResolvedShader["entryPoints"] {
    return this.resolved.entryPoints;
  }

  get stats(): ResolvedShader["stats"] {
    return this.resolved.stats;
  }
}
