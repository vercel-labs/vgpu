import type { ResourceIdentity, UnsubscribeResourceDestroy } from "@vgpu/core";
import { bindingLifetimeTestState, createBindingLifetimeService, type BindingLifetimeService, type LifetimeDependent, type ResourceLifetimeMarker } from "./binding-lifetime.ts";

/** A bound range of a buffer: the same buffer at another offset or size is another binding. */
export interface BufferRangeIdentity { readonly kind: string; readonly id: number; readonly offset: number; readonly size: number }
export type BindGroupIdentityPart = ResourceIdentity | { readonly kind: string; readonly id: number } | BufferRangeIdentity | string | number;
export type BindGroupFactory = () => GPUBindGroup;
export interface BindGroupKeyPart { readonly binding: number; readonly key: BindGroupIdentityPart }

/** Identity kind of a range captured into a pooled frame uniform page. */
export const CAPTURE_PAGE_KIND = "uniform-page";
/**
 * Bind groups kept per owner, least recently used evicted first; captured variants are also bounded
 * per (owner, group) because captured ranges move between pooled pages with frames in flight and
 * draw order. Evicting an entry never invalidates a bind group already encoded into a command or bundle.
 */
export const MAX_OWNER_ENTRIES = 64;
export const MAX_CAPTURE_VARIANTS = 16;

export interface BindGroupCache {
  readonly lifetime: BindingLifetimeService;
  getOrCreate(
    owner: object,
    group: number,
    layout: GPUBindGroupLayout,
    bindings: readonly BindGroupKeyPart[],
    dependencies: readonly BindGroupIdentityPart[],
    factory: BindGroupFactory,
  ): GPUBindGroup;
  marker(
    resource: object,
    identity: BindGroupIdentityPart,
    subscribe: (callback: () => void) => UnsubscribeResourceDestroy,
  ): ResourceLifetimeMarker;
  /**
   * Evicts every entry that depends on the identity's resource, at any range. With `unusedSince`
   * (a {@link bindGroupClock} value), entries used after it are kept.
   */
  evictIdentity(identity: BindGroupIdentityPart, unusedSince?: number): void;
  /** Evicts the owner's entries, or only those of one group. */
  clearOwner(owner: object, group?: number): void;
  dispose(): void;
}

interface OwnerShard {
  readonly groups: Map<number, Map<GPUBindGroupLayout, Map<string, CacheEntry>>>;
  readonly lru: Map<CacheEntry, true>;
  readonly captures: Map<number, Map<CacheEntry, true>>;
}

class CacheEntry implements LifetimeDependent {
  record?: number;
  used = ++clock;

  constructor(
    readonly cache: CacheState,
    readonly shard: WeakRef<OwnerShard>,
    readonly group: number,
    readonly layout: GPUBindGroupLayout,
    readonly key: string,
    readonly capture: boolean,
    readonly bindGroup: GPUBindGroup,
  ) {}

  invalidateLifetime(): void {
    removeEntry(this.cache, this);
  }
}

interface CacheState {
  readonly lifetime: BindingLifetimeService;
  shards: WeakMap<object, OwnerShard>;
  disposed: boolean;
}

const states = new WeakMap<BindGroupCache, CacheState>();
let clock = 0;

/** Monotonic use clock shared by every cache: each entry records the value of its last use. */
export function bindGroupClock(): number {
  return clock;
}

export function createBindGroupCache(): BindGroupCache {
  const state: CacheState = { lifetime: createBindingLifetimeService(), shards: new WeakMap(), disposed: false };
  const cache: BindGroupCache = {
    lifetime: state.lifetime,
    getOrCreate(owner, group, layout, bindings, dependencies, factory) {
      let shard = state.shards.get(owner);
      if (!shard) {
        shard = { groups: new Map(), lru: new Map(), captures: new Map() };
        state.shards.set(owner, shard);
      }
      let layouts = shard.groups.get(group);
      if (!layouts) shard.groups.set(group, layouts = new Map());
      let entries = layouts.get(layout);
      if (!entries) layouts.set(layout, entries = new Map());
      const key = bindingKey(bindings);
      const existing = entries.get(key);
      if (existing) {
        state.lifetime.maintain();
        existing.used = ++clock;
        touch(shard.lru, existing);
        if (existing.capture) touch(shard.captures.get(group)!, existing);
        return existing.bindGroup;
      }
      const capture = bindings.some(({ key }) => isCapturedRange(key));
      const entry = new CacheEntry(state, new WeakRef(shard), group, layout, key, capture, factory());
      entries.set(key, entry);
      shard.lru.set(entry, true);
      entry.record = state.lifetime.register(entry, dependencies.map(baseIdentityKey));
      if (capture) {
        let variants = shard.captures.get(group);
        if (!variants) shard.captures.set(group, variants = new Map());
        variants.set(entry, true);
        if (variants.size > MAX_CAPTURE_VARIANTS) removeEntry(state, variants.keys().next().value!);
      }
      if (shard.lru.size > MAX_OWNER_ENTRIES) removeEntry(state, shard.lru.keys().next().value!);
      return entry.bindGroup;
    },
    marker(resource, identity, subscribe) {
      return state.lifetime.marker(resource, baseIdentityKey(identity), subscribe);
    },
    evictIdentity(identity, unusedSince) {
      state.lifetime.invalidate(
        baseIdentityKey(identity),
        unusedSince === undefined ? undefined : (target) => !(target instanceof CacheEntry) || target.used <= unusedSince,
      );
    },
    clearOwner(owner, group) {
      state.lifetime.maintain();
      const shard = state.shards.get(owner);
      if (!shard) return;
      for (const entry of [...shard.lru.keys()]) if (group === undefined || entry.group === group) removeEntry(state, entry);
      if (group === undefined) state.shards.delete(owner);
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      state.shards = new WeakMap();
      state.lifetime.dispose();
    },
  };
  states.set(cache, state);
  return cache;
}

const keys = new WeakMap<object, string>();

/** Full identity: `kind:id`, plus `@offset+size` for a buffer range. Identity objects are immutable, so keys are memoized. */
export function identityKey(identity: BindGroupIdentityPart): string {
  if (typeof identity === "string" || typeof identity === "number") return `${typeof identity}:${String(identity)}`;
  let key = keys.get(identity);
  if (key === undefined) {
    key = `${identity.kind}:${identity.id}`;
    if ("offset" in identity) key += `@${identity.offset}+${identity.size}`;
    keys.set(identity, key);
  }
  return key;
}

/** The resource behind an identity, ignoring its range: what destruction and page eviction track. */
export function baseIdentityKey(identity: BindGroupIdentityPart): string {
  if (typeof identity === "string" || typeof identity === "number") return `${typeof identity}:${String(identity)}`;
  return `${identity.kind}:${identity.id}`;
}

export function bindGroupCacheTestState(cache: BindGroupCache) {
  const state = states.get(cache);
  if (!state) throw new TypeError("Unknown bind group cache");
  const lifetime = bindingLifetimeTestState(state.lifetime);
  return {
    lifetime,
    ownerEntries(owner: object): number { return state.shards.get(owner)?.lru.size ?? 0; },
    ownerShard(owner: object): object | undefined { return state.shards.get(owner); },
    /** Reachable entries that have dependencies; computed from the weak reverse records, test use only. */
    trackedEntries(): number { return lifetime.liveTargets().filter((target) => target instanceof CacheEntry).length; },
  };
}

function touch(lru: Map<CacheEntry, true>, entry: CacheEntry): void {
  lru.delete(entry);
  lru.set(entry, true);
}

function bindingKey(bindings: readonly BindGroupKeyPart[]): string {
  let sorted = true;
  for (let index = 1; index < bindings.length; index++) if (bindings[index - 1]!.binding > bindings[index]!.binding) sorted = false;
  const ordered = sorted ? bindings : [...bindings].sort((left, right) => left.binding - right.binding);
  // Length-prefixed parts keep arbitrary identity strings unambiguous without JSON encoding.
  let key = "";
  for (const { binding, key: identity } of ordered) {
    const part = identityKey(identity);
    key += `${binding}:${part.length}:${part}`;
  }
  return key;
}

function isCapturedRange(identity: BindGroupIdentityPart): boolean {
  return typeof identity === "object" && identity.kind === CAPTURE_PAGE_KIND;
}

function removeEntry(state: CacheState, entry: CacheEntry): void {
  state.lifetime.unregister(entry.record);
  entry.record = undefined;
  const shard = entry.shard.deref();
  if (!shard) return;
  const layouts = shard.groups.get(entry.group);
  const entries = layouts?.get(entry.layout);
  if (entries?.get(entry.key) !== entry) return;
  entries.delete(entry.key);
  shard.lru.delete(entry);
  const variants = entry.capture ? shard.captures.get(entry.group) : undefined;
  variants?.delete(entry);
  if (variants?.size === 0) shard.captures.delete(entry.group);
  if (entries.size === 0) layouts!.delete(entry.layout);
  if (layouts?.size === 0) shard.groups.delete(entry.group);
}
