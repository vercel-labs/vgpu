import { getMockGPUDeviceInstrumentation, type Gpu } from "vgpu/mock";

const UNIFORM_BUFFER_USAGE = 0x40;

export function uniformBindingFloats(
  gpu: Gpu,
  labels: string | readonly string[],
  binding?: number
): number[][] {
  const values: number[][] = [];
  const seen = new Map<GPUBuffer, Set<string>>();
  for (const label of typeof labels === "string" ? [labels] : labels) {
    for (const descriptor of getMockGPUDeviceInstrumentation(gpu.device.gpu)
      .createBindGroupDescriptors) {
      if (!descriptor.label?.startsWith(`${label}.group`)) continue;
      for (const entry of descriptor.entries) {
        if (binding !== undefined && entry.binding !== binding) continue;
        const { resource } = entry;
        if (
          !("buffer" in resource) ||
          (resource.buffer.usage & UNIFORM_BUFFER_USAGE) === 0 ||
          resource.size === undefined
        )
          continue;
        const offset = resource.offset ?? 0;
        const size = resource.size;
        const key = `${offset}:${size}`;
        const slices = seen.get(resource.buffer) ?? new Set<string>();
        if (slices.has(key)) continue;
        slices.add(key);
        seen.set(resource.buffer, slices);
        if (
          !("__vgpuMockBytes" in resource.buffer) ||
          !(resource.buffer.__vgpuMockBytes instanceof Uint8Array)
        )
          throw new Error(
            "The public mock backend did not expose packed buffer bytes"
          );
        const bytes = resource.buffer.__vgpuMockBytes;
        values.push([
          ...new Float32Array(
            bytes.buffer,
            bytes.byteOffset + offset,
            size / Float32Array.BYTES_PER_ELEMENT
          ),
        ]);
      }
    }
  }
  return values;
}
