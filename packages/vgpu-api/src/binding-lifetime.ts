import type { UnsubscribeResourceDestroy } from "@vgpu/core";

export interface LifetimeDependent {
  invalidateLifetime(record: number, dependency: string): void;
}

export interface ResourceLifetimeMarker {
  readonly dependency: string;
  readonly destroyed: boolean;
}

interface MutableResourceLifetimeMarker extends ResourceLifetimeMarker {
  destroyed: boolean;
  unsubscribe?: UnsubscribeResourceDestroy;
}

interface ReverseRecord {
  readonly id: number;
  target: WeakRef<LifetimeDependent> | { deref(): undefined };
  readonly dependencies: readonly string[];
  readonly token: object;
  previous?: number;
  next?: number;
}

export interface BindingLifetimeService {
  marker(
    resource: object,
    dependency: string,
    subscribe: (callback: () => void) => UnsubscribeResourceDestroy,
  ): ResourceLifetimeMarker;
  register(target: LifetimeDependent, dependencies: readonly string[]): number | undefined;
  unregister(record: number | undefined): void;
  invalidate(dependency: string): void;
  maintain(): void;
  dispose(): void;
}

export interface BindingLifetimeTestState {
  readonly records: number;
  readonly recordIds: readonly number[];
  readonly dependencyBuckets: number;
  readonly maintenanceVisits: number;
  readonly targetedVisits: number;
  forceDead(record: number): void;
  maintain(): void;
}

const MAINTENANCE_BUDGET = 16;
const internals = new WeakMap<BindingLifetimeService, LifetimeInternals>();

interface LifetimeInternals {
  readonly records: Map<number, ReverseRecord>;
  readonly dependencies: Map<string, Set<number>>;
  readonly markerRefs: Map<number, WeakRef<MutableResourceLifetimeMarker>>;
  readonly markerFinalizer: FinalizationRegistry<number>;
  readonly finalizer: FinalizationRegistry<number>;
  head?: number;
  cursor?: number;
  nextRecord: number;
  nextMarker: number;
  maintenanceVisits: number;
  targetedVisits: number;
  disposed: boolean;
}

export function createBindingLifetimeService(): BindingLifetimeService {
  const markers = new WeakMap<object, MutableResourceLifetimeMarker>();
  const state: LifetimeInternals = {
    records: new Map(),
    dependencies: new Map(),
    markerRefs: new Map(),
    markerFinalizer: new FinalizationRegistry((marker) => state.markerRefs.delete(marker)),
    finalizer: new FinalizationRegistry((record) => removeRecord(state, record)),
    nextRecord: 1,
    nextMarker: 1,
    maintenanceVisits: 0,
    targetedVisits: 0,
    disposed: false,
  };

  const service: BindingLifetimeService = {
    marker(resource, dependency, subscribe) {
      let marker = markers.get(resource);
      if (marker) return marker;
      service.maintain();
      marker = { dependency, destroyed: false };
      markers.set(resource, marker);
      const markerId = state.nextMarker++;
      const markerRef = new WeakRef(marker);
      state.markerRefs.set(markerId, markerRef);
      state.markerFinalizer.register(marker, markerId, markerRef);
      const serviceRef = new WeakRef(service);
      marker.unsubscribe = subscribeMarker(subscribe, marker, markerId, markerRef, serviceRef);
      return marker;
    },
    register(target, dependencies) {
      if (state.disposed) return undefined;
      service.maintain();
      if (dependencies.length === 0) return undefined;
      const id = state.nextRecord++;
      const record: ReverseRecord = {
        id,
        target: new WeakRef(target),
        dependencies: [...new Set(dependencies)],
        token: {},
      };
      appendRecord(state, record);
      for (const dependency of record.dependencies) {
        let bucket = state.dependencies.get(dependency);
        if (!bucket) state.dependencies.set(dependency, bucket = new Set());
        bucket.add(id);
      }
      state.finalizer.register(target, id, record.token);
      return id;
    },
    unregister(record) {
      if (record !== undefined) removeRecord(state, record);
    },
    invalidate(dependency) {
      service.maintain();
      const bucket = state.dependencies.get(dependency);
      if (!bucket) return;
      for (const id of [...bucket]) {
        state.targetedVisits += 1;
        const record = state.records.get(id);
        if (!record) continue;
        const target = record.target.deref();
        if (target) target.invalidateLifetime(id, dependency);
        removeRecord(state, id);
      }
    },
    maintain() {
      if (state.disposed || state.head === undefined) return;
      let id = state.cursor ?? state.head;
      for (let visited = 0; visited < MAINTENANCE_BUDGET && state.head !== undefined; visited += 1) {
        const record = state.records.get(id);
        if (!record) {
          id = state.head;
          continue;
        }
        state.maintenanceVisits += 1;
        const next = record.next ?? state.head;
        if (!record.target.deref()) removeRecord(state, id);
        if (state.head === undefined) break;
        id = state.records.has(next) ? next : state.head;
      }
      state.cursor = state.head === undefined ? undefined : id;
    },
    dispose() {
      if (state.disposed) return;
      state.disposed = true;
      for (const reference of state.markerRefs.values()) {
        state.markerFinalizer.unregister(reference);
        reference.deref()?.unsubscribe?.();
      }
      state.markerRefs.clear();
      for (const id of [...state.records.keys()]) removeRecord(state, id);
      state.dependencies.clear();
      state.head = undefined;
      state.cursor = undefined;
    },
  };
  internals.set(service, state);
  return service;
}

function subscribeMarker(
  subscribe: (callback: () => void) => UnsubscribeResourceDestroy,
  marker: MutableResourceLifetimeMarker,
  markerId: number,
  unregisterToken: WeakRef<MutableResourceLifetimeMarker>,
  serviceRef: WeakRef<BindingLifetimeService>,
): UnsubscribeResourceDestroy {
  return subscribe(() => {
    if (marker.destroyed) return;
    marker.destroyed = true;
    const service = serviceRef.deref();
    const state = service && internals.get(service);
    if (!service || !state) return;
    state.markerFinalizer.unregister(unregisterToken);
    state.markerRefs.delete(markerId);
    service.invalidate(marker.dependency);
  });
}

export function bindingLifetimeTestState(service: BindingLifetimeService): BindingLifetimeTestState {
  const state = internals.get(service);
  if (!state) throw new TypeError("Unknown binding lifetime service");
  return {
    get records() { return state.records.size; },
    get recordIds() { return [...state.records.keys()]; },
    get dependencyBuckets() { return state.dependencies.size; },
    get maintenanceVisits() { return state.maintenanceVisits; },
    get targetedVisits() { return state.targetedVisits; },
    forceDead(record) {
      const entry = state.records.get(record);
      if (entry) entry.target = { deref: () => undefined };
    },
    maintain() { service.maintain(); },
  };
}

function appendRecord(state: LifetimeInternals, record: ReverseRecord): void {
  if (state.head === undefined) {
    record.previous = record.id;
    record.next = record.id;
    state.head = record.id;
    state.cursor = record.id;
  } else {
    const head = state.records.get(state.head)!;
    const tail = state.records.get(head.previous!)!;
    record.previous = tail.id;
    record.next = head.id;
    tail.next = record.id;
    head.previous = record.id;
  }
  state.records.set(record.id, record);
}

function removeRecord(state: LifetimeInternals, id: number): void {
  const record = state.records.get(id);
  if (!record) return;
  state.finalizer.unregister(record.token);
  for (const dependency of record.dependencies) {
    const bucket = state.dependencies.get(dependency);
    bucket?.delete(id);
    if (bucket?.size === 0) state.dependencies.delete(dependency);
  }
  if (record.next === id) {
    state.head = undefined;
    state.cursor = undefined;
  } else {
    const previous = state.records.get(record.previous!);
    const next = state.records.get(record.next!);
    if (previous) previous.next = record.next;
    if (next) next.previous = record.previous;
    if (state.head === id) state.head = record.next;
    if (state.cursor === id) state.cursor = record.next;
  }
  state.records.delete(id);
}
