import type { ResourceIdentity, UnsubscribeResourceDestroy } from "@vgpu/core";

export type BindGroupIdentityPart = ResourceIdentity | { readonly kind: string; readonly id: number } | string | number;
export type BindGroupFactory = () => GPUBindGroup;

export interface BindGroupCache {
  getOrCreate(drawId: number | string, group: number, identityTuple: readonly BindGroupIdentityPart[], factory: BindGroupFactory): GPUBindGroup;
  evictIdentity(identity: BindGroupIdentityPart): void;
  clearDraw(drawId: number | string): void;
  dispose(): void;
}

export function createBindGroupCache(): BindGroupCache {
  const entries = new Map<string, { readonly identities: readonly string[]; readonly bindGroup: GPUBindGroup }>();

  return {
    getOrCreate(drawId, group, identityTuple, factory) {
      const identities = identityTuple.map(identityKey);
      const key = `${drawId}:${group}:${identities.join("|")}`;
      const existing = entries.get(key);
      if (existing) return existing.bindGroup;
      const bindGroup = factory();
      entries.set(key, { identities, bindGroup });
      return bindGroup;
    },
    evictIdentity(identity) {
      const needle = identityKey(identity);
      for (const [key, entry] of entries) {
        if (entry.identities.includes(needle)) entries.delete(key);
      }
    },
    clearDraw(drawId) {
      const prefix = `${drawId}:`;
      for (const key of entries.keys()) if (key.startsWith(prefix)) entries.delete(key);
    },
    dispose() {
      entries.clear();
    },
  };
}

export function identityKey(identity: BindGroupIdentityPart): string {
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
