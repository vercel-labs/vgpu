import type { Device } from "@vgpu/core";
import type { BindGroupCache, BindGroupIdentityPart } from "./bind-cache.ts";

export interface UniformValue { readonly owner: object; readonly revision: number; readonly bytes: Uint8Array }
export interface UniformCapture {
  capture(value: UniformValue, cache: BindGroupCache): { resource: GPUBufferBinding; identity: BindGroupIdentityPart };
}
interface Page { buffer: GPUBuffer; bytes: Uint8Array; used: number }
const pools = new WeakMap<Device, Page[]>();
let nextArena = 1;

/** Only completed frames return pages to this pool; outstanding manual frames never share pages. */
export class FrameUniforms implements UniformCapture {
  readonly #id = nextArena++;
  readonly #pages: Page[] = [];
  readonly #values = new Map<object, Map<number, { resource: GPUBufferBinding; identity: string }>>();
  readonly #evictions = new Map<BindGroupCache, Set<string>>();
  #released = false;
  constructor(private readonly device: Device) {}

  capture(value: UniformValue, cache: BindGroupCache): { resource: GPUBufferBinding; identity: string } {
    let versions = this.#values.get(value.owner);
    if (!versions) { versions = new Map(); this.#values.set(value.owner, versions); }
    let captured = versions.get(value.revision);
    if (!captured) {
      const alignment = this.device.limits.minUniformBufferOffsetAlignment || 256;
      const size = value.bytes.byteLength;
      let page = this.#pages.at(-1);
      let offset = Math.ceil((page?.used ?? 0) / alignment) * alignment;
      if (!page || offset + size > page.bytes.byteLength) {
        const pool = pools.get(this.device) ?? [];
        pools.set(this.device, pool);
        const index = pool.findIndex(candidate => candidate.bytes.byteLength >= size);
        page = index >= 0 ? pool.splice(index, 1)[0]! : this.#createPage(size);
        page.used = 0;
        this.#pages.push(page);
        offset = 0;
      }
      page.bytes.set(value.bytes, offset);
      page.used = offset + size;
      captured = { resource: { buffer: page.buffer, offset, size }, identity: `uniform-capture:${this.#id}:${this.#pages.length}:${offset}` };
      versions.set(value.revision, captured);
    }
    let identities = this.#evictions.get(cache);
    if (!identities) { identities = new Set(); this.#evictions.set(cache, identities); }
    identities.add(captured.identity);
    return captured;
  }

  flush(): void {
    for (const page of this.#pages) this.device.gpu.queue.writeBuffer(page.buffer, 0, page.bytes.buffer, 0, Math.ceil(page.used / 4) * 4);
  }

  release(): void {
    if (this.#released) return;
    this.#released = true;
    for (const [cache, identities] of this.#evictions) for (const identity of identities) cache.evictIdentity(identity);
    const pool = pools.get(this.device);
    for (const page of this.#pages) {
      if (pool && pool.length < 8) pool.push(page);
      else page.buffer.destroy();
    }
    this.#pages.length = 0;
    this.#values.clear();
    this.#evictions.clear();
  }

  #createPage(minimum: number): Page {
    const size = Math.min(this.device.limits.maxBufferSize, Math.max(65536, Math.ceil(minimum / 4) * 4));
    return { buffer: this.device.gpu.createBuffer({ label: "vgpu.frame.uniforms", size, usage: 0x40 | 0x08 }), bytes: new Uint8Array(size), used: 0 };
  }
}

export function disposeFrameUniforms(device: Device): void {
  for (const page of pools.get(device) ?? []) page.buffer.destroy();
  pools.delete(device);
}
