/**
 * Validation for GPU-read draw/dispatch arguments, split out of `storage.ts` so the encoders can
 * check an `indirect` option without linking the storage buffer implementation: `draw()` and
 * `compute()` accept indirect arguments, but a program that never passes one — every fullscreen
 * effect, for one — should not pay for `storage(gpu, bytes)`.
 *
 * The check is structural on purpose: it accepts this package's storage facade and anything with
 * the same core buffer underneath, which is what `ping-pong` hands out.
 */
import { Buffer } from "@vgpu/core";
import type { StorageBuffer } from "./api-types.ts";
import { indirectInvalidError } from "./errors.ts";
import type { RingStorageBuffer } from "./storage.ts";

/** A storage buffer supplying GPU-read arguments, bare or wrapped with a byte offset (default 0). */
export type IndirectOption = StorageBuffer | { readonly buffer: StorageBuffer; readonly offset?: number };

/**
 * WebGPU indirect argument layouts: drawIndirect reads "a tightly packed block of four 32-bit unsigned integer values
 * (16 bytes total)", drawIndexedIndirect "a tightly packed block of five 32-bit values (20 bytes total)" (baseVertex is
 * signed), and dispatchWorkgroupsIndirect "a tightly packed block of three 32-bit unsigned integer values (12 bytes total)".
 */
const INDIRECT_METHODS = {
  drawIndirect: { bytes: 16, args: "4 u32 values: vertexCount, instanceCount, firstVertex, firstInstance" },
  drawIndexedIndirect: { bytes: 20, args: "5 32-bit values: indexCount, instanceCount, firstIndex, baseVertex (signed), firstInstance" },
  dispatchWorkgroupsIndirect: { bytes: 12, args: "3 u32 values: workgroupCountX, workgroupCountY, workgroupCountZ" },
} as const;

export type IndirectMethod = keyof typeof INDIRECT_METHODS;

/**
 * Validates an indirect option against the WebGPU rules shared by drawIndirect, drawIndexedIndirect, and
 * dispatchWorkgroupsIndirect — "indirectBuffer.usage contains INDIRECT", "indirectOffset + sizeof(<indirect
 * parameters>) ≤ indirectBuffer.size", and "indirectOffset is a multiple of 4" — and unwraps the GPUBuffer.
 *
 * @internal
 */
export function resolveIndirect(label: string, where: string, value: IndirectOption, method: IndirectMethod): { readonly buffer: GPUBuffer; readonly offset: number } {
  const wrapped = typeof value === "object" && value !== null ? (value as { buffer?: unknown }).buffer : undefined;
  const storage = isStorageBufferFacade(value) ? value : isStorageBufferFacade(wrapped) ? wrapped : undefined;
  if (!storage) throw indirectInvalidError(label, `received ${previewIndirect(value)}; expected a StorageBuffer or { buffer, offset? }.`, where);
  const offset = storage === value ? 0 : (value as { offset?: number }).offset ?? 0;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) throw indirectInvalidError(label, `offset must be an integer >= 0; received ${previewIndirect(offset)}.`, where);
  if (offset % 4 !== 0) throw indirectInvalidError(label, `offset must be a multiple of 4 (WebGPU requires "indirectOffset is a multiple of 4"); received ${offset}.`, where);
  if (!storage.buffer.options.usage.includes("indirect")) {
    throw indirectInvalidError(label, `the buffer lacks the "indirect" usage (WebGPU requires "indirectBuffer.usage contains INDIRECT"); create it with storage(gpu, ${storage.size}, { indirect: true }).`, where);
  }
  const { bytes, args } = INDIRECT_METHODS[method];
  if (offset + bytes > storage.size) {
    throw indirectInvalidError(label, `${method} reads ${bytes} bytes (${args}) at offset ${offset}, but offset + ${bytes} = ${offset + bytes} exceeds the buffer size ${storage.size}.`, where);
  }
  return { buffer: storage.gpu, offset };
}

function isStorageBufferFacade(value: unknown): value is RingStorageBuffer {
  return typeof value === "object" && value !== null && "gpu" in value && "size" in value && (value as { buffer?: unknown }).buffer instanceof Buffer;
}

function previewIndirect(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
