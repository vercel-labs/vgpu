import type { UniformCapture, UniformValue } from "./frame-uniforms.ts";
import { bindGroupLayoutMetadata, bindGroupMetadataFor, type Buffer, type Device } from "@vgpu/core";
import type { BindingInfo, Reflection } from "@vgpu/wgsl/reflect-source";
import { bindGroupKeyOf, identityKey, type BindGroupCache, type BindGroupIdentityPart, type BindGroupKeyPart } from "./bind-cache.ts";
import { entryMetadata } from "./entry-metadata.ts";
import { claimedGroupIncompatibleError, claimedGroupSetError, destroyedBindingError, neverSetError, ownershipFlipError, unsupportedError } from "./errors.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, pipelineLayoutFor } from "./set-layouts.ts";
import { assertResourceBindable, isPlainObject, isPlainValue, normalizeResource } from "./set-resources.ts";
import { bytesEqual } from "./bytes-equal.ts";
import { writeLayoutValue } from "./set-packing.ts";
import type { BindingLifetimeService, ResourceLifetimeMarker } from "./binding-lifetime.ts";
import type { FollowedTargetBinding, NormalizedBindingResource } from "./set-resources.ts";

export type SetBag = Record<string, unknown>;
export type BindingOwnership = "lib" | "user";

export interface SetCoreOptions {
  readonly device: Device;
  readonly label: string;
  readonly reflection: Reflection;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly cache: BindGroupCache;
  readonly disposedError: (operation: string) => Error;
}

export interface BindingIdentityChange {
  readonly group: number;
  readonly binding: number;
  readonly bindingName: string;
  readonly bindingKind: string;
  readonly previousIdentity?: string;
  readonly newIdentity: string;
}

/** Ring-1 set() engine: latches ownership, validates completeness, and returns cached bind groups. */
export interface SetCore {
  dispose(): void;
  assertUsable(): void;
  preflight(): void;
  refreshLayouts(): void;
  captureResources(): readonly BindingResourceSnapshot[];
  readonly groups: readonly number[];
  set(values: SetBag): readonly BindingIdentityChange[];
  claimGroup(group: number, bindGroup: GPUBindGroup, expectedLayout: GPUBindGroupLayout): string | undefined;
  layout(group: number): GPUBindGroupLayout;
  bindGroups(capture?: UniformCapture): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } }[];
  bindingState(name: string): BindingState | undefined;
}

export interface BindingResourceSnapshot {
  readonly lifetime: BindingLifetimeService;
  readonly markers: readonly ResourceLifetimeMarker[];
  readonly group: number;
  readonly binding: number;
  readonly bindingName: string;
  readonly bindingKind: string;
  readonly capturedIdentity: string;
  readonly resourceLabel?: string;
  readonly followedTarget?: FollowedTargetBinding;
}

export interface BindingState {
  readonly info: BindingInfo;
  readonly ownership: BindingOwnership;
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
  readonly underlyingBuffer?: GPUBuffer;
}

export interface SetCoreTestState {
  readonly cache: BindGroupCache;
  readonly owner: object;
  /** Full binding scans, and bind group constructions (arrays, required state) of unclaimed groups. */
  readonly stats: { readonly fullVerifications: number; readonly groupPlanBuilds: number };
}

interface ActiveGroup {
  readonly layout: GPUBindGroupLayout;
  readonly active: ReadonlySet<number>;
  readonly bindings: readonly BindingInfo[];
}

/** A static group's bind group inputs, valid until the next binding mutation; the cache owns the bind group. */
interface GroupPlan {
  readonly layout: GPUBindGroupLayout;
  readonly keys: readonly BindGroupKeyPart[];
  readonly dependencies: readonly BindGroupIdentityPart[];
  readonly key: string;
  readonly factory: () => GPUBindGroup;
}

const EMPTY: readonly number[] = Object.freeze([]);
const setCoreTestStates = new WeakMap<SetCore, SetCoreTestState | { readonly disposedError: (operation: string) => Error }>();
const noCleanupFailure = Symbol("no cleanup failure");

type MutableBindingState = {
  readonly info: BindingInfo;
  ownership?: BindingOwnership;
  readonly memberOwnership: Map<string, BindingOwnership>;
  readonly captureToken: object;
  buffer?: Buffer;
  bytes?: ArrayBuffer;
  revision?: number;
  dirtyUniform?: boolean;
  liveUniform?: boolean;
  uniformValue?: () => UniformValue;
  ownedValue?: UniformValue;
  prepareUniform?: (retain: boolean) => void;
  libValue?: unknown;
  resource?: GPUBindingResource;
  identity?: BindGroupIdentityPart;
  cacheIdentity?: BindGroupIdentityPart;
  resourceLabel?: string;
  sourceValue?: unknown;
  followedTarget?: FollowedTargetBinding;
  markers?: readonly ResourceLifetimeMarker[];
  dependencies?: readonly BindGroupIdentityPart[];
  underlyingBuffer?: GPUBuffer;
  mayHaveNativeConsumers?: boolean;
};

/** Creates the per-Draw binding state machine used by Effect/Draw.set(). */
export function createSetCore(options: SetCoreOptions): SetCore {
  let liveOptions: SetCoreOptions | undefined = options;
  const label = options.label;
  const disposedError = options.disposedError;
  const bindings = initializeBindings(options.reflection);
  const groups = [...options.bindGroupLayouts.keys()].sort((a, b) => a - b);
  const claimedGroups = new Map<number, GPUBindGroup>();
  const cacheOwner = {};
  const activeByGroup = new Map<number, ActiveGroup>();
  const stats = { fullVerifications: 0, groupPlanBuilds: 0 };
  // Unchanged encodes skip the full binding scan while nothing was mutated since it last passed
  // (`revision` moves at every mutation site) and no tracked resource was destroyed (the lifetime
  // service's destroy epoch). Static groups reuse their plan until the next mutation.
  let revision = 0;
  let verifiedRevision = -1;
  let verifiedEpoch = -1;
  let followed: MutableBindingState[] = [];
  const plans = new Map<number, GroupPlan>();
  refreshLayouts();

  function changed(): void {
    revision++;
    plans.clear();
  }

  function current(operation: string): SetCoreOptions {
    if (!liveOptions) throw disposedError(operation);
    return liveOptions;
  }

  function set(values: SetBag): readonly BindingIdentityChange[] {
    current("set");
    const changes: BindingIdentityChange[] = [];
    for (const [name, value] of Object.entries(values)) changes.push(...setNamedValue(name, value));
    return changes;
  }

  function bindingIsActive(state: MutableBindingState): boolean {
    return activeByGroup.get(state.info.group)?.active.has(state.info.binding) ?? false;
  }

  /** Resolves the reflected bindings present in each group's current layout, once per layout object. */
  function refreshLayouts(): void {
    const options = current("layout");
    for (const [group, layout] of options.bindGroupLayouts) {
      const previous = activeByGroup.get(group);
      if (previous?.layout === layout) continue;
      // A replaced layout (draw.layout(n, { dynamicOffsets: true })) retires the bind groups built for the old one.
      if (previous) { options.cache.clearOwner(cacheOwner, group); changed(); }
      const active = new Set(bindGroupLayoutMetadata(layout)?.entries.map((entry) => entry.binding) ?? []);
      const bindings = options.reflection.bindings.filter((binding) => binding.group === group && active.has(binding.binding));
      activeByGroup.set(group, { layout, active, bindings });
    }
  }

  function setNamedValue(name: string, value: unknown): readonly BindingIdentityChange[] {
    const direct = bindings.get(name);
    if (direct) return setBinding(direct, name, value);
    const member = findMemberBinding(name, bindings, label);
    if (!member) throw unsupportedError(`${label}.set`, `Binding '${name}' does not exist in '${label}'.`);
    return setBindingMember(member, name, value);
  }

  function setBinding(state: MutableBindingState, name: string, value: unknown): readonly BindingIdentityChange[] {
    assertResourceBindable(state.info, value, label);
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    assertBindingOwnership(state, name, ownership);
    const before = identityString(state.identity);
    if (ownership === "lib") setLibOwned(state, mergeLibValue(state.libValue, value));
    else setUserOwned(state, value);
    state.ownership ??= ownership;
    return bindingIsActive(state) ? identityChangeFor(state, before) : [];
  }

  function setBindingMember(state: MutableBindingState, memberName: string, value: unknown): readonly BindingIdentityChange[] {
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    assertBindingOwnership(state, memberName, ownership);
    assertMemberOwnership(state, memberName, ownership);
    if (ownership !== "lib") throw unsupportedError(`${label}.set`, `Member '${memberName}' needs a JS value; set resource '${state.info.name}' instead.`);
    const before = identityString(state.identity);
    const base = state.libValue ?? zeroLayoutValue(requiredLibLayout(state));
    setLibOwned(state, { ...objectValue(base), [memberName]: value });
    state.ownership ??= ownership;
    state.memberOwnership.set(memberName, ownership);
    return bindingIsActive(state) ? identityChangeFor(state, before) : [];
  }

  function setLibOwned(state: MutableBindingState, value: unknown): void {
    const layout = requiredLibLayout(state);
    const bytes = writeLayoutValue(layout, value);
    state.libValue = value;
    if (!state.buffer) createLibBuffer(state, layout.size);
    // Equal packed bytes keep the revision (and frame snapshot) and any pending upload as they are.
    if (!state.bytes || !bytesEqual(state.bytes, bytes)) {
      state.bytes = bytes;
      state.revision = (state.revision ?? 0) + 1;
      state.dirtyUniform = true;
    }
    // Storage and live uniform buffers can change behind our back: always write them.
    if (state.liveUniform || state.info.addressSpace !== "uniform") {
      state.dirtyUniform = true;
      prepareUniform(state, false);
    }
  }

  function prepareUniform(state: MutableBindingState, retain: boolean): void {
    state.prepareUniform?.(retain);
    if (state.dirtyUniform) {
      state.buffer!.write(state.bytes!, 0);
      state.dirtyUniform = false;
    }
    if (retain) state.liveUniform = true;
  }

  function resourceContext(binding: BindingInfo) {
    const options = current("set");
    const entry = bindGroupLayoutMetadata(options.bindGroupLayouts.get(binding.group)!)?.entries.find((item) => item.binding === binding.binding);
    const pair = options.reflection.entryPoints.flatMap((item) => entryMetadata(item, "samplingPairs", label)).find((item) => item.mode === "filtering" && item.texture.group === binding.group && item.texture.binding === binding.binding);
    const pairedSampler = pair && options.reflection.bindings.find((item) => item.group === pair.sampler.group && item.binding === pair.sampler.binding);
    return { device: options.device, cache: options.cache, sourceHint: label, filterableTexture: entry?.texture?.sampleType === "float", float32Filterable: options.device.features.has("float32-filterable"), pairedSampler };
  }

  function setUserOwned(state: MutableBindingState, value: unknown): void {
    const normalized = normalizeResource(state.info, value, resourceContext(state.info));
    commitNormalized(state, value, normalized);
  }

  function commitNormalized(state: MutableBindingState, value: unknown, normalized: NormalizedBindingResource): void {
    const options = current("set");
    changed();
    state.resource = normalized.resource;
    state.uniformValue = normalized.uniformValue;
    state.prepareUniform = normalized.prepareUniform;
    state.identity = normalized.identity;
    state.cacheIdentity = normalized.cacheIdentity;
    state.resourceLabel = normalized.resourceLabel;
    state.sourceValue = value;
    state.followedTarget = normalized.followedTarget;
    state.markers = normalized.tracked?.map(({ resource, identity, subscribe }) => options.cache.marker(resource, identity, subscribe));
    state.dependencies = normalized.tracked?.map(({ identity }) => identity) ?? [];
    state.underlyingBuffer = normalized.underlyingBuffer;
  }

  function claimGroup(group: number, bindGroup: GPUBindGroup, expectedLayout: GPUBindGroupLayout): string | undefined {
    layout(group);
    validateClaimedGroup(label, group, bindGroup, expectedLayout);
    const previousIdentity = claimedGroups.has(group) ? `claimed-group:${group}` : undefined;
    claimedGroups.set(group, bindGroup);
    changed();
    return previousIdentity;
  }

  function refreshFollowedTarget(state: MutableBindingState): void {
    const followed = state.followedTarget;
    if (!followed) return;
    if (state.markers?.[0]?.destroyed) throw destroyedBindingError(label, state.info, state.resourceLabel);
    const selected = followed.depth ? followed.target.depth : followed.target.color;
    if (!selected || identityKey(selected.resourceIdentity) === identityString(state.identity)) return;
    commitNormalized(state, followed.target, normalizeResource(state.info, followed.target, resourceContext(state.info)));
  }

  function assertUsable(): void {
    current("bindingState");
    for (const state of bindings.values()) {
      if (!bindingIsActive(state) || claimedGroups.has(state.info.group) || !state.resource) continue;
      refreshFollowedTarget(state);
      if (state.markers?.some((marker) => marker.destroyed)) throw destroyedBindingError(label, state.info, state.resourceLabel);
    }
  }

  function preflight(): void {
    const epoch = current("preflight").cache.lifetime.destroyEpoch;
    if (verifiedRevision === revision && verifiedEpoch === epoch) {
      // A followed Target can swap attachments without destroying them yet; a refresh recommits and moves the revision.
      for (const state of followed) refreshFollowedTarget(state);
      if (verifiedRevision === revision) return;
    }
    stats.fullVerifications++;
    assertUsable();
    for (const state of bindings.values()) if (bindingIsActive(state) && !claimedGroups.has(state.info.group)) requiredState(state.info);
    // Stamps move only after a passing scan, so a failing binding keeps failing every encode until fixed.
    followed = [...bindings.values()].filter((state) => state.followedTarget && state.resource && bindingIsActive(state) && !claimedGroups.has(state.info.group));
    verifiedRevision = revision;
    verifiedEpoch = epoch;
  }

  function captureResources(): readonly BindingResourceSnapshot[] {
    const options = current("resourceSnapshots");
    preflight();
    const snapshots: BindingResourceSnapshot[] = [];
    for (const state of bindings.values()) {
      if (!bindingIsActive(state) || claimedGroups.has(state.info.group)) continue;
      if (state.info.addressSpace === "uniform") prepareUniform(state, true);
      if (!state.markers?.length && !state.followedTarget) continue;
      snapshots.push({
        lifetime: options.cache.lifetime,
        markers: state.markers ?? [],
        group: state.info.group,
        binding: state.info.binding,
        bindingName: state.info.name,
        bindingKind: state.info.kind,
        capturedIdentity: identityString(state.identity)!,
        resourceLabel: state.resourceLabel,
        followedTarget: state.followedTarget,
      });
    }
    return snapshots;
  }

  function layout(group: number): GPUBindGroupLayout {
    const options = current("layout");
    const bgl = options.bindGroupLayouts.get(group);
    if (!bgl) throw unsupportedError(`${label}.layout`, `@group(${group}) does not exist in '${label}'.`);
    return bgl;
  }

  function bindGroups(capture?: UniformCapture): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } }[] {
    current("bindGroups");
    preflight();
    return groups.map(group => bindGroupFor(group, capture));
  }

  function bindGroupFor(group: number, capture?: UniformCapture): { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } } {
    const options = current("bindGroups");
    const claimed = claimedGroups.get(group);
    if (claimed) return { group, bindGroup: claimed, offsets: EMPTY, claimValidation: rawClaimValidation(claimed, group) };
    const plan = plans.get(group);
    if (plan) return { group, bindGroup: options.cache.getOrCreate(cacheOwner, group, plan.layout, plan.keys, plan.dependencies, plan.factory, plan.key), offsets: EMPTY };
    stats.groupPlanBuilds++;
    const groupBindings = activeByGroup.get(group)?.bindings ?? [];
    const resources: GPUBindingResource[] = [];
    const keys: BindGroupKeyPart[] = [];
    const dependencies: BindGroupIdentityPart[] = [];
    // Managed, shared and JS-owned uniform values are captured or flushed per encode, so their groups never get a plan.
    let fixed = true;
    for (const binding of groupBindings) {
      const state = requiredState(binding);
      const value = state.uniformValue?.() ?? (state.bytes && binding.addressSpace === "uniform" ? ownedUniformValue(state) : undefined);
      if (value || state.uniformValue || state.prepareUniform) fixed = false;
      const captured = capture && value ? capture.capture(value, options.cache) : undefined;
      if (!captured) prepareUniform(state, false);
      if (!captured && state.buffer) state.mayHaveNativeConsumers = true;
      resources.push(captured?.resource ?? state.resource!);
      keys.push({ binding: binding.binding, key: captured?.identity ?? state.cacheIdentity ?? state.identity! });
      if (captured) dependencies.push(captured.identity);
      else if (state.dependencies) dependencies.push(...state.dependencies);
    }
    const bindGroupLayout = layout(group);
    const factory = () => options.device.gpu.createBindGroup({
      label: `${label}.group${group}`,
      layout: bindGroupLayout,
      entries: groupBindings.map((binding, index) => ({ binding: binding.binding, resource: resources[index]! })),
    });
    const key = bindGroupKeyOf(keys);
    if (fixed) plans.set(group, { layout: bindGroupLayout, keys, dependencies, key, factory });
    return { group, bindGroup: options.cache.getOrCreate(cacheOwner, group, bindGroupLayout, keys, dependencies, factory, key), offsets: EMPTY };
  }

  function rawClaimValidation(bindGroup: GPUBindGroup, group: number): { readonly label: string; readonly group: number } | undefined {
    return bindGroupMetadataFor(bindGroup) ? undefined : { label, group };
  }

  function requiredState(binding: BindingInfo): MutableBindingState {
    const state = bindings.get(binding.name);
    if (!state?.resource || !state.identity) throw neverSetError(label, binding);
    return state;
  }

  function ensureGroupSettable(group: number): void {
    if (claimedGroups.has(group)) throw claimedGroupSetError(label, group);
  }

  function createLibBuffer(state: MutableBindingState, size: number): void {
    const options = current("set");
    changed();
    state.buffer = options.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label: `${label}.${state.info.name}` });
    state.resource = { buffer: state.buffer.gpu, offset: 0, size };
    state.identity = state.buffer.resourceIdentity;
    state.markers = [options.cache.marker(state.buffer, state.buffer.resourceIdentity, (callback) => state.buffer!.onDestroy(callback))];
    state.dependencies = [state.buffer.resourceIdentity];
    state.underlyingBuffer = state.buffer.gpu;
  }

  function requiredLibLayout(state: MutableBindingState): NonNullable<BindingInfo["layout"]> & { readonly size: number } {
    if (state.info.kind !== "buffer" || !state.info.layout?.size) throw unsupportedError(`${label}.set`, `Binding '${state.info.name}' needs a compatible resource, not JS.`);
    return state.info.layout as NonNullable<BindingInfo["layout"]> & { readonly size: number };
  }

  const core: SetCore = {
    dispose() {
      const closing = liveOptions;
      if (!closing) return;
      liveOptions = undefined;
      setCoreTestStates.set(core, { disposedError });
      let failure: unknown = noCleanupFailure;
      try { closing.cache.clearOwner(cacheOwner); } catch (error) { failure = error; }
      for (const state of bindings.values()) {
        if (!state.buffer || state.mayHaveNativeConsumers) continue;
        try { state.buffer.destroy(); } catch (error) { if (failure === noCleanupFailure) failure = error; }
      }
      bindings.clear();
      claimedGroups.clear();
      activeByGroup.clear();
      plans.clear();
      followed = [];
      if (failure !== noCleanupFailure) throw failure;
    },
    assertUsable,
    preflight,
    refreshLayouts,
    captureResources,
    get groups() { current("groups"); return groups; },
    set,
    claimGroup,
    layout,
    bindGroups,
    bindingState(name) {
      current("bindingState");
      const state = bindings.get(name);
      if (!state?.ownership || !state.resource || !state.identity) return undefined;
      if (state.buffer) state.mayHaveNativeConsumers = true;
      return { info: state.info, ownership: state.ownership, resource: state.resource, identity: state.identity, underlyingBuffer: state.underlyingBuffer };
    },
  };
  setCoreTestStates.set(core, { cache: options.cache, owner: cacheOwner, stats });
  return core;
}

export function setCoreTestState(core: SetCore): SetCoreTestState {
  const state = setCoreTestStates.get(core);
  if (!state) throw new TypeError("Unknown SetCore");
  if ("disposedError" in state) throw state.disposedError("cacheOwner");
  return state;
}

function ownedUniformValue(state: MutableBindingState): UniformValue {
  const value = state.ownedValue;
  if (value && value.revision === state.revision) return value;
  // The inert capture token, not the binding state: a pending frame capture must not retain consumer state.
  return state.ownedValue = { owner: state.captureToken, revision: state.revision!, bytes: new Uint8Array(state.bytes!) };
}

function initializeBindings(reflection: Reflection): Map<string, MutableBindingState> {
  return new Map(reflection.bindings.map((binding) => [binding.name, { info: binding, memberOwnership: new Map(), captureToken: {} }]));
}

function reflectedGroups(reflection: Reflection): readonly number[] {
  return [...new Set(reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
}

function findMemberBinding(memberName: string, bindings: ReadonlyMap<string, MutableBindingState>, label: string): MutableBindingState | undefined {
  let match: MutableBindingState | undefined;
  for (const state of bindings.values()) {
    if (!state.info.layout?.members?.some((member) => member.name === memberName)) continue;
    if (match) throw unsupportedError(`${label}.set`, `Binding member '${memberName}' is ambiguous in '${label}'; set the complete binding.`);
    match = state;
  }
  return match;
}

function ownershipFor(binding: BindingInfo, value: unknown): BindingOwnership {
  return binding.bindingLayout?.kind === "buffer" && isPlainValue(value) ? "lib" : "user";
}

function assertBindingOwnership(state: MutableBindingState, name: string, ownership: BindingOwnership): void {
  if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(name, state.ownership);
}

function assertMemberOwnership(state: MutableBindingState, memberName: string, ownership: BindingOwnership): void {
  const previous = state.memberOwnership.get(memberName);
  if (previous && previous !== ownership) throw ownershipFlipError(memberName, previous);
}

function validateClaimedGroup(label: string, group: number, bindGroup: GPUBindGroup, expectedLayout: GPUBindGroupLayout): void {
  const claimedMetadata = bindGroupMetadataFor(bindGroup);
  if (!claimedMetadata) return;
  const expectedMetadata = bindGroupLayoutMetadata(expectedLayout);
  if (!expectedMetadata) return;
  const reason = layoutMismatchReason(expectedMetadata.entries, claimedMetadata.layout.entries);
  if (reason) throw claimedGroupIncompatibleError(label, group, reason);
}

function layoutMismatchReason(expected: readonly GPUBindGroupLayoutEntry[], claimed: readonly GPUBindGroupLayoutEntry[]): string | undefined {
  if (expected.length !== claimed.length) return `expected ${expected.length} bindings and received ${claimed.length}`;
  const expectedByBinding = entriesByBinding(expected);
  const claimedByBinding = entriesByBinding(claimed);
  for (const [binding, entry] of expectedByBinding) {
    const claimedEntry = claimedByBinding.get(binding);
    if (!claimedEntry) return `missing @binding(${binding})`;
    if (entrySignature(entry) !== entrySignature(claimedEntry)) return `@binding(${binding}) does not match the reflected layout`;
  }
  return undefined;
}

function entriesByBinding(entries: readonly GPUBindGroupLayoutEntry[]): ReadonlyMap<number, GPUBindGroupLayoutEntry> {
  return new Map(entries.map((entry) => [entry.binding, entry]));
}

function entrySignature(entry: GPUBindGroupLayoutEntry): string {
  return JSON.stringify({
    binding: entry.binding,
    visibility: entry.visibility,
    buffer: entry.buffer,
    sampler: entry.sampler,
    texture: entry.texture,
    storageTexture: entry.storageTexture,
    externalTexture: entry.externalTexture ? {} : undefined,
  });
}

function identityChangeFor(state: MutableBindingState, previousIdentity: string | undefined): readonly BindingIdentityChange[] {
  const nextIdentity = identityString(state.identity);
  if (!nextIdentity || previousIdentity === nextIdentity) return [];
  return [{
    group: state.info.group,
    binding: state.info.binding,
    bindingName: state.info.name,
    bindingKind: state.info.kind,
    previousIdentity,
    newIdentity: nextIdentity,
  }];
}

function identityString(identity: BindGroupIdentityPart | undefined): string | undefined {
  return identity === undefined ? undefined : identityKey(identity);
}

function mergeLibValue(previous: unknown, value: unknown): unknown {
  return isPlainObject(previous) && isPlainObject(value) ? { ...previous, ...value } : value;
}

function objectValue(value: unknown): Record<string, unknown> {
  return isPlainObject(value) ? value : {};
}

function zeroLayoutValue(layout: NonNullable<BindingInfo["layout"]>): unknown {
  if (layout.members) return Object.fromEntries(layout.members.map((member) => [member.name, zeroLayoutValue(member.layout)]));
  switch (layout.type.kind) {
    case "scalar":
    case "atomic":
      return 0;
    case "vector":
      return Array.from({ length: layout.type.width }, () => 0);
    case "matrix":
      return Array.from({ length: layout.type.columns * layout.type.rows }, () => 0);
    case "array": {
      const element = layout.element;
      if (layout.type.count === undefined || !element) return [];
      return Array.from({ length: layout.type.count }, () => zeroLayoutValue(element));
    }
    default:
      return undefined;
  }
}

export { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, pipelineLayoutFor } from "./set-layouts.ts";
export { writeLayoutValue } from "./set-packing.ts";
