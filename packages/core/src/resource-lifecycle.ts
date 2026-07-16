export type ResourceKind = "buffer" | "texture" | "render-target";

export interface ResourceIdentity {
  readonly kind: ResourceKind;
  readonly id: number;
}

export type ResourceDestroyCallback<T> = (resource: T) => void;
export type UnsubscribeResourceDestroy = () => void;

let nextResourceId = 1;

export function createResourceIdentity(kind: ResourceKind): ResourceIdentity {
  return Object.freeze({ kind, id: nextResourceId++ });
}

export class DestroySignal<T> {
  private readonly callbacks = new Set<ResourceDestroyCallback<T>>();
  private destroyed = false;

  onDestroy(resource: T, cb: ResourceDestroyCallback<T>): UnsubscribeResourceDestroy {
    if (this.destroyed) {
      cb(resource);
      return () => undefined;
    }
    this.callbacks.add(cb);
    return () => { this.callbacks.delete(cb); };
  }

  emit(resource: T): boolean {
    if (this.destroyed) return false;
    this.destroyed = true;
    const callbacks = [...this.callbacks];
    this.callbacks.clear();
    for (const cb of callbacks) cb(resource);
    return true;
  }
}
