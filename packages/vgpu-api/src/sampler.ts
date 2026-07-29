import type { Device } from "@vgpu/core";
import { liveKernel } from "./live-kernel.ts";
import type { Gpu } from "./kernel.ts";
import { renderService } from "./render-service.ts";

/**
 * Cached `GPUSampler` for this gpu: identical descriptors return the identical sampler, so bind
 * groups keyed on resource identity stay stable across frames.
 *
 * The cache lives in the gpu's render service — the same one `draw()` and `effect()` use — and is
 * created on first use, not at `init()`.
 */
export function sampler(gpu: Gpu, desc?: GPUSamplerDescriptor): GPUSampler {
  return renderService(liveKernel(gpu, "sampler")).sampler(desc);
}

export interface SamplerCache {
  sampler(desc?: GPUSamplerDescriptor): GPUSampler;
  identity(sampler: GPUSampler): { readonly kind: "sampler"; readonly id: number };
}

let nextSamplerId = 1;

export function createSamplerCache(device: Device): SamplerCache {
  const byKey = new Map<string, GPUSampler>();
  const ids = new WeakMap<GPUSampler, { readonly kind: "sampler"; readonly id: number }>();
  return {
    sampler(desc: GPUSamplerDescriptor = {}) {
      const key = stableKey(desc);
      let sampler = byKey.get(key);
      if (!sampler) {
        sampler = device.gpu.createSampler(desc);
        byKey.set(key, sampler);
        ids.set(sampler, { kind: "sampler", id: nextSamplerId++ });
      }
      return sampler;
    },
    identity(sampler) {
      let id = ids.get(sampler);
      if (!id) {
        id = { kind: "sampler", id: nextSamplerId++ };
        ids.set(sampler, id);
      }
      return id;
    },
  };
}

function stableKey(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableKey).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableKey(record[key])}`).join(",")}}`;
}
