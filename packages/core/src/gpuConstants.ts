import type { BufferUsageName } from "./types.js";

const fallbackUsage: Record<BufferUsageName, number> = {
  map_read: 1,
  map_write: 2,
  copy_src: 4,
  copy_dst: 8,
  index: 16,
  vertex: 32,
  uniform: 64,
  storage: 128,
  indirect: 256,
  query_resolve: 512,
};

export function bufferUsageFlags(usages: readonly BufferUsageName[]): GPUBufferUsageFlags {
  const constants = globalThis.GPUBufferUsage as unknown as Record<string, number> | undefined;
  return usages.reduce((flags, usage) => flags | usageFlag(usage, constants), 0) as GPUBufferUsageFlags;
}

function usageFlag(usage: BufferUsageName, constants?: Record<string, number>): number {
  const key = usage.toUpperCase();
  return constants?.[key] ?? fallbackUsage[usage];
}

export function mapReadMode(): GPUMapModeFlags {
  return (globalThis.GPUMapMode?.READ ?? 1) as GPUMapModeFlags;
}
