import type { Device } from "@vgpu/core";
import { CAPTURE_PAGE_KIND, bindGroupClock, type BindGroupCache, type BindGroupIdentityPart, type BufferRangeIdentity } from "./bind-cache.ts";

export interface UniformValue { readonly owner: object; readonly revision: number; readonly bytes: Uint8Array }
export interface UniformCapture {
  capture(value: UniformValue, cache: BindGroupCache): { resource: GPUBufferBinding; identity: BindGroupIdentityPart };
}
interface Page {
  readonly id: number;
  readonly buffer: GPUBuffer;
  readonly bytes: Uint8Array;
  used: number;
  /** Bind-group clock when the current owner frame took the page. */
  taken: number;
  /** Caches holding bind groups of this page's ranges. */
  readonly caches: Set<BindGroupCache>;
}
interface Pool { readonly pages: Page[]; bytes: number }
interface Captured { readonly revision: number; readonly page: Page; readonly resource: GPUBufferBinding; readonly identity: BufferRangeIdentity }

/**
 * Idle pages kept per device, in both pages and GPU bytes (each page also has a same-sized CPU
 * shadow). Pages owned by frames still recording or executing are not counted: they are bounded by
 * the work in flight.
 */
export const MAX_RETAINED_UNIFORM_PAGES = 256;
export const MAX_RETAINED_UNIFORM_BYTES = 16 * 1024 * 1024;

const pools = new WeakMap<Device, Pool>();
const disposed = new WeakSet<Device>();
let nextPage = 1;

/**
 * Captures each uniform revision into an aligned range of a pooled page. A page belongs to one
 * frame until that frame completes or is abandoned, so frames in flight never share a range; the
 * pool hands pages back first in, first out, so a repeated frame captures into the same physical
 * ranges and finds its bind groups again.
 */
export class FrameUniforms implements UniformCapture {
  readonly #pages: Page[] = [];
  readonly #latest = new Map<object, Captured>();
  #released = false;
  constructor(private readonly device: Device) {}

  capture(value: UniformValue, cache: BindGroupCache): { resource: GPUBufferBinding; identity: BufferRangeIdentity } {
    let captured = this.#latest.get(value.owner);
    if (captured?.revision !== value.revision) {
      captured = this.#write(value);
      this.#latest.set(value.owner, captured);
    }
    captured.page.caches.add(cache);
    return captured;
  }

  flush(): void {
    for (const page of this.#pages) this.device.gpu.queue.writeBuffer(page.buffer, 0, page.bytes.buffer, 0, Math.ceil(page.used / 4) * 4);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    const pool = disposed.has(this.device) ? undefined : pools.get(this.device);
    for (const page of this.#pages) {
      if (pool && pool.pages.length < MAX_RETAINED_UNIFORM_PAGES && pool.bytes + page.bytes.byteLength <= MAX_RETAINED_UNIFORM_BYTES) {
        // Bind groups this frame did not use belong to draws that moved or stopped drawing.
        for (const cache of page.caches) cache.evictIdentity(pageIdentity(page), page.taken);
        pool.pages.push(page);
        pool.bytes += page.bytes.byteLength;
      } else destroyPage(page);
    }
    this.#pages.length = 0;
    this.#latest.clear();
  }

  #write(value: UniformValue): Captured {
    const alignment = this.device.limits.minUniformBufferOffsetAlignment || 256;
    const size = value.bytes.byteLength;
    let page = this.#pages.at(-1);
    let offset = Math.ceil((page?.used ?? 0) / alignment) * alignment;
    if (!page || offset + size > page.bytes.byteLength) {
      page = this.#take(size);
      this.#pages.push(page);
      offset = 0;
    }
    page.bytes.set(value.bytes, offset);
    page.used = offset + size;
    return { revision: value.revision, page, resource: { buffer: page.buffer, offset, size }, identity: { kind: CAPTURE_PAGE_KIND, id: page.id, offset, size } };
  }

  #take(minimum: number): Page {
    let pool = pools.get(this.device);
    if (!pool && !disposed.has(this.device)) pools.set(this.device, pool = { pages: [], bytes: 0 });
    const index = pool?.pages.findIndex(candidate => candidate.bytes.byteLength >= minimum) ?? -1;
    const page = index >= 0 ? pool!.pages.splice(index, 1)[0]! : this.#createPage(minimum);
    if (index >= 0) pool!.bytes -= page.bytes.byteLength;
    page.used = 0;
    page.taken = bindGroupClock();
    return page;
  }

  #createPage(minimum: number): Page {
    const size = Math.min(this.device.limits.maxBufferSize, Math.max(65536, Math.ceil(minimum / 4) * 4));
    const buffer = this.device.gpu.createBuffer({ label: "vgpu.frame.uniforms", size, usage: 0x40 | 0x08 });
    return { id: nextPage++, buffer, bytes: new Uint8Array(size), used: 0, taken: 0, caches: new Set() };
  }
}

function pageIdentity(page: Page): BindGroupIdentityPart {
  return { kind: CAPTURE_PAGE_KIND, id: page.id };
}

function destroyPage(page: Page): void {
  for (const cache of page.caches) cache.evictIdentity(pageIdentity(page));
  page.caches.clear();
  page.buffer.destroy();
}

/** Destroys the idle pages; pages of frames still in flight are destroyed when those frames complete. */
export function disposeFrameUniforms(device: Device): void {
  disposed.add(device);
  for (const page of pools.get(device)?.pages ?? []) destroyPage(page);
  pools.delete(device);
}
