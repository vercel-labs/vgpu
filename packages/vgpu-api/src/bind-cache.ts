import type { ResourceIdentity, UnsubscribeResourceDestroy } from "@vgpu/core";

/** A bound range of a buffer: the same buffer at another offset or size is another binding. */
export interface BufferRangeIdentity { readonly kind: string; readonly id: number; readonly offset: number; readonly size: number }
export type BindGroupIdentityPart = ResourceIdentity | { readonly kind: string; readonly id: number } | BufferRangeIdentity | string | number;
export type BindGroupFactory = () => GPUBindGroup;

/** Identity kind of a range captured into a pooled frame uniform page. */
export const CAPTURE_PAGE_KIND = "uniform-page";
/**
 * Bind groups kept per (draw, group), least recently used evicted first. Captured ranges move
 * between pooled pages with frames in flight and draw order; resources change with set().
 * Evicting an entry never invalidates a bind group already encoded into a command or bundle.
 */
export const MAX_CAPTURE_VARIANTS = 16;
export const MAX_RESOURCE_VARIANTS = 64;

export interface BindGroupCacheStats { readonly entries: number; readonly draws: number; readonly dependencies: number; readonly buckets: number }

export interface BindGroupCache {
  getOrCreate(drawId: number | string, group: number, identityTuple: readonly BindGroupIdentityPart[], factory: BindGroupFactory): GPUBindGroup;
  /**
   * Evicts every entry that references the identity's resource, at any range. With `unusedSince`
   * (a {@link bindGroupClock} value), entries used after it are kept.
   */
  evictIdentity(identity: BindGroupIdentityPart, unusedSince?: number): void;
  /** Evicts the draw's entries, or only those of one group. */
  clearDraw(drawId: number | string, group?: number): void;
  dispose(): void;
  /** @internal Index sizes, for tests and benchmarks. */
  stats(): BindGroupCacheStats;
}

interface Entry {
  readonly key: string;
  readonly draw: string;
  readonly bucket: string;
  readonly bindGroup: GPUBindGroup;
  readonly dependencies: readonly string[];
  used: number;
}

let clock = 0;

/** Monotonic use clock shared by every cache: each entry records the value of its last use. */
export function bindGroupClock(): number {
  return clock;
}

export function createBindGroupCache(): BindGroupCache {
  const entries = new Map<string, Entry>();
  const byDraw = new Map<string, Set<Entry>>();
  const byDependency = new Map<string, Set<Entry>>();
  const buckets = new Map<string, Set<Entry>>();

  function remove(entry: Entry): void {
    if (entries.get(entry.key) !== entry) return;
    entries.delete(entry.key);
    unlink(byDraw, entry.draw, entry);
    unlink(buckets, entry.bucket, entry);
    for (const dependency of entry.dependencies) unlink(byDependency, dependency, entry);
  }

  return {
    getOrCreate(drawId, group, identityTuple, factory) {
      let key = `${drawId}:${group}:`;
      for (let index = 0; index < identityTuple.length; index++) key += (index ? "|" : "") + identityKey(identityTuple[index]!);
      const existing = entries.get(key);
      if (existing) {
        existing.used = ++clock;
        return existing.bindGroup;
      }
      const bindGroup = factory();
      const capture = identityTuple.some(isCapturedRange);
      const draw = String(drawId);
      const entry: Entry = {
        key, draw, bindGroup,
        bucket: `${draw}:${group}:${capture ? "capture" : "resource"}`,
        dependencies: [...new Set(identityTuple.map(baseIdentityKey))],
        used: ++clock,
      };
      entries.set(key, entry);
      link(byDraw, draw, entry);
      for (const dependency of entry.dependencies) link(byDependency, dependency, entry);
      const variants = link(buckets, entry.bucket, entry);
      if (variants.size > (capture ? MAX_CAPTURE_VARIANTS : MAX_RESOURCE_VARIANTS)) remove(leastRecentlyUsed(variants));
      return bindGroup;
    },
    evictIdentity(identity, unusedSince) {
      for (const entry of byDependency.get(baseIdentityKey(identity)) ?? []) {
        if (unusedSince === undefined || entry.used <= unusedSince) remove(entry);
      }
    },
    clearDraw(drawId, group) {
      const prefix = `${drawId}:${group}:`;
      for (const entry of byDraw.get(String(drawId)) ?? []) if (group === undefined || entry.bucket.startsWith(prefix)) remove(entry);
    },
    dispose() {
      entries.clear();
      byDraw.clear();
      byDependency.clear();
      buckets.clear();
    },
    stats() {
      return { entries: entries.size, draws: byDraw.size, dependencies: byDependency.size, buckets: buckets.size };
    },
  };
}

function link(index: Map<string, Set<Entry>>, key: string, entry: Entry): Set<Entry> {
  let set = index.get(key);
  if (!set) index.set(key, set = new Set());
  set.add(entry);
  return set;
}

function unlink(index: Map<string, Set<Entry>>, key: string, entry: Entry): void {
  const set = index.get(key);
  if (!set?.delete(entry) || set.size) return;
  index.delete(key);
}

function leastRecentlyUsed(variants: ReadonlySet<Entry>): Entry {
  let oldest: Entry | undefined;
  for (const entry of variants) if (!oldest || entry.used < oldest.used) oldest = entry;
  return oldest!;
}

function isCapturedRange(identity: BindGroupIdentityPart): boolean {
  return typeof identity === "object" && identity.kind === CAPTURE_PAGE_KIND;
}

const keys = new WeakMap<object, string>();

/** Full identity: `kind:id`, plus `@offset+size` for a buffer range. Identity objects are immutable, so keys are memoized. */
export function identityKey(identity: BindGroupIdentityPart): string {
  if (typeof identity === "string" || typeof identity === "number") return String(identity);
  let key = keys.get(identity);
  if (key === undefined) {
    key = `${identity.kind}:${identity.id}`;
    if ("offset" in identity) key += `@${identity.offset}+${identity.size}`;
    keys.set(identity, key);
  }
  return key;
}

/** The resource behind an identity, ignoring its range. */
export function baseIdentityKey(identity: BindGroupIdentityPart): string {
  if (typeof identity === "string" || typeof identity === "number") return String(identity);
  return `${identity.kind}:${identity.id}`;
}

export function subscribeEviction(
  resource: { onDestroy?: (cb: (resource: unknown) => void) => UnsubscribeResourceDestroy; readonly resourceIdentity?: ResourceIdentity },
  cache: BindGroupCache,
): UnsubscribeResourceDestroy | undefined {
  const identity = resource.resourceIdentity;
  if (!identity || typeof resource.onDestroy !== "function") return undefined;
  return resource.onDestroy(() => cache.evictIdentity(identity));
}
