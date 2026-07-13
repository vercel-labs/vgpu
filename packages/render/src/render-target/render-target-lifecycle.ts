import { createResourceIdentity, DestroySignal, type ResourceDestroyCallback, type ResourceIdentity, type Texture, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { RenderTarget } from "./types.ts";

export interface RenderTargetLifecycle {
  readonly resourceIdentity: ResourceIdentity;
  bind(target: RenderTarget): void;
  onDestroy(cb: ResourceDestroyCallback<RenderTarget>): UnsubscribeResourceDestroy;
}

export function createRenderTargetLifecycle(textures: readonly (Texture | undefined)[]): RenderTargetLifecycle {
  const identity = createResourceIdentity("render-target");
  const destroySignal = new DestroySignal<RenderTarget>();
  let target: RenderTarget | undefined;
  let unsubscribers: UnsubscribeResourceDestroy[] = [];

  const emit = () => {
    if (!target) return;
    if (!destroySignal.emit(target)) return;
    const current = unsubscribers;
    unsubscribers = [];
    for (const unsubscribe of current) unsubscribe();
  };

  unsubscribers = textures.filter((texture): texture is Texture => texture !== undefined).map((texture) => texture.onDestroy(emit));

  return {
    resourceIdentity: identity,
    bind(value: RenderTarget): void { target = value; },
    onDestroy(cb: ResourceDestroyCallback<RenderTarget>): UnsubscribeResourceDestroy {
      if (!target) throw new Error("RenderTarget lifecycle is not bound yet");
      return destroySignal.onDestroy(target, cb);
    },
  };
}
