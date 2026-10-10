import { Texture, type Device } from "@vgpu/core";
import type { BindGroupCache } from "./bind-cache.ts";
import type { BindingLifetimeService, LifetimeDependent } from "./binding-lifetime.ts";

export interface BindingTextureView {
  readonly view: GPUTextureView;
  readonly key: string;
}

class TextureViewVariants implements LifetimeDependent {
  // Descriptor keys are a finite generated set. Weak values let inert keys outlive an abandoned
  // cache/service on a retained Texture without keeping native view wrappers alive.
  readonly views = new Map<string, WeakRef<GPUTextureView>>();
  readonly registered = new WeakSet<BindingLifetimeService>();
  destroyed = false;

  invalidateLifetime(): void {
    this.destroyed = true;
    this.views.clear();
  }
}

const records = new WeakMap<Texture, TextureViewVariants>();

/** Reuses only the finite descriptors emitted by binding normalization. */
export function bindingTextureView(texture: Texture, descriptor: GPUTextureViewDescriptor | undefined, cache: BindGroupCache, device: Device): BindingTextureView {
  const canonical = canonicalViewDescriptor(texture, descriptor);
  if (canonical.defaultEquivalent) return { view: texture.view, key: canonical.key };

  // The generated variant may be reused from another consuming cache/device, so use Texture.view
  // as the public check for this Texture's own wrapper/device. It allocates at most one finite
  // default sentinel; subsequent non-default hits only perform liveness checks.
  void texture.view;
  // The caller also has to remain usable; normalization normally checks this through Device
  // features before entering the helper, while direct internal callers get the same guard here.
  void device.limits;
  let variants = records.get(texture);
  if (!variants) {
    variants = new TextureViewVariants();
    records.set(texture, variants);
  }
  if (!variants.registered.has(cache.lifetime)) {
    const marker = cache.marker(texture, texture.resourceIdentity, callback => texture.onDestroy(callback));
    cache.lifetime.register(variants, [marker.dependency]);
    variants.registered.add(cache.lifetime);
  }
  if (variants.destroyed) return { view: texture.createView(descriptor), key: canonical.key };
  let view = variants.views.get(canonical.key)?.deref();
  if (!view) {
    view = texture.createView(descriptor);
    variants.views.set(canonical.key, new WeakRef(view));
  }
  return { view, key: canonical.key };
}

export function bindingViewCacheTestState(texture: Texture): { readonly variants: number; readonly destroyed: boolean } {
  const record = records.get(texture);
  return { variants: record?.views.size ?? 0, destroyed: record?.destroyed ?? false };
}

function canonicalViewDescriptor(texture: Texture, descriptor: GPUTextureViewDescriptor | undefined): { readonly key: string; readonly defaultEquivalent: boolean } {
  const dimension = descriptor?.dimension ?? defaultDimension(texture);
  const baseMipLevel = descriptor?.baseMipLevel ?? 0;
  const mipLevelCount = descriptor?.mipLevelCount ?? texture.mipLevelCount - baseMipLevel;
  const baseArrayLayer = descriptor?.baseArrayLayer ?? 0;
  const arrayLayerCount = descriptor?.arrayLayerCount ?? defaultLayerCount(texture, dimension, baseArrayLayer);
  const aspect = descriptor?.aspect ?? "all";
  const usage = descriptor?.usage === undefined || descriptor.usage === 0 ? texture.gpu.usage : descriptor.usage;
  const swizzle = descriptor?.swizzle ?? "rgba";
  const format = descriptor?.format ?? "@default";
  const fields = { format, dimension, aspect, baseMipLevel, mipLevelCount, baseArrayLayer, arrayLayerCount, usage, swizzle };
  const defaults = {
    format: "@default",
    dimension: defaultDimension(texture),
    aspect: "all",
    baseMipLevel: 0,
    mipLevelCount: texture.mipLevelCount,
    baseArrayLayer: 0,
    arrayLayerCount: defaultLayerCount(texture, defaultDimension(texture), 0),
    usage: texture.gpu.usage,
    swizzle: "rgba",
  };
  return { key: JSON.stringify(fields), defaultEquivalent: JSON.stringify(fields) === JSON.stringify(defaults) };
}

function defaultDimension(texture: Texture): GPUTextureViewDimension {
  return texture.kind === "2d-array" ? "2d-array" : texture.kind;
}

function defaultLayerCount(texture: Texture, dimension: GPUTextureViewDimension, baseArrayLayer: number): number {
  return dimension === "2d-array" || dimension === "cube" || dimension === "cube-array"
    ? texture.layers - baseArrayLayer
    : 1;
}
