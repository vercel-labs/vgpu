import type { Device } from "@vgpu/core";
import { invalidUsage } from "../uniform-pool-internals.ts";
import { samplerDescriptor, type MaterialSamplerSpec } from "./material-textures-schema.ts";

export interface Sampler { readonly gpu: GPUSampler; }

export function sampler(device: Device, spec: MaterialSamplerSpec): Sampler {
  try {
    return Object.freeze({ gpu: device.gpu.createSampler(samplerDescriptor(spec)) });
  } catch (error) {
    throw invalidUsage("sampler", error instanceof Error ? error.message : String(error));
  }
}
