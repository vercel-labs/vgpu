import { bindGroupLayoutMetadata, bindGroupMetadataFor, type Buffer, type Device, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo, Reflection } from "@vgpu/wgsl/reflect-source";
import { identityKey, type BindGroupCache, type BindGroupIdentityPart } from "./bind-cache.ts";
import { claimedGroupIncompatibleError, claimedGroupSetError, neverSetError, ownershipFlipError, unsupportedError } from "./errors.ts";
import { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, pipelineLayoutFor } from "./set-layouts.ts";
import { isPlainObject, isPlainValue, normalizeResource } from "./set-resources.ts";
import { writeLayoutValue } from "./set-packing.ts";

export type SetBag = Record<string, unknown>;
export type BindingOwnership = "lib" | "user";

export interface SetCoreOptions {
  readonly device: Device;
  readonly label: string;
  readonly drawId: number;
  readonly reflection: Reflection;
  readonly bindGroupLayouts: ReadonlyMap<number, GPUBindGroupLayout>;
  readonly cache: BindGroupCache;
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
  readonly groups: readonly number[];
  set(values: SetBag): readonly BindingIdentityChange[];
  claimGroup(group: number, bindGroup: GPUBindGroup, expectedLayout: GPUBindGroupLayout): string | undefined;
  layout(group: number): GPUBindGroupLayout;
  bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } }[];
  bindingState(name: string): BindingState | undefined;
}

export interface BindingState {
  readonly info: BindingInfo;
  readonly ownership: BindingOwnership;
  readonly resource: GPUBindingResource;
  readonly identity: BindGroupIdentityPart;
}

type MutableBindingState = {
  readonly info: BindingInfo;
  ownership?: BindingOwnership;
  readonly memberOwnership: Map<string, BindingOwnership>;
  buffer?: Buffer;
  bytes?: ArrayBuffer;
  libValue?: unknown;
  resource?: GPUBindingResource;
  identity?: BindGroupIdentityPart;
  unsubscribe?: UnsubscribeResourceDestroy;
};

/** Creates the per-Draw binding state machine used by Pass/Draw.set(). */
export function createSetCore(options: SetCoreOptions): SetCore {
  const bindings = initializeBindings(options.reflection);
  const groups = reflectedGroups(options.reflection);
  const claimedGroups = new Map<number, GPUBindGroup>();

  function set(values: SetBag): readonly BindingIdentityChange[] {
    const changes: BindingIdentityChange[] = [];
    for (const [name, value] of Object.entries(values)) changes.push(...setNamedValue(name, value));
    return changes;
  }

  function setNamedValue(name: string, value: unknown): readonly BindingIdentityChange[] {
    const direct = bindings.get(name);
    if (direct) return setBinding(direct, name, value);
    const member = findMemberBinding(name, bindings, options.label);
    if (!member) throw unsupportedError(`${options.label}.set`, `Binding '${name}' no existe en '${options.label}'.`);
    return setBindingMember(member, name, value);
  }

  function setBinding(state: MutableBindingState, name: string, value: unknown): readonly BindingIdentityChange[] {
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    latchBindingOwnership(state, name, ownership);
    const before = identityString(state.identity);
    if (ownership === "lib") setLibOwned(state, mergeLibValue(state.libValue, value));
    else setUserOwned(state, value);
    return identityChangeFor(state, before);
  }

  function setBindingMember(state: MutableBindingState, memberName: string, value: unknown): readonly BindingIdentityChange[] {
    ensureGroupSettable(state.info.group);
    const ownership = ownershipFor(state.info, value);
    latchBindingOwnership(state, memberName, ownership);
    latchMemberOwnership(state, memberName, ownership);
    if (ownership !== "lib") throw unsupportedError(`${options.label}.set`, `Binding member '${memberName}' no puede recibir recursos; seteá el binding completo '${state.info.name}'.`);
    const before = identityString(state.identity);
    setLibOwned(state, { ...objectValue(state.libValue), [memberName]: value });
    return identityChangeFor(state, before);
  }

  function setLibOwned(state: MutableBindingState, value: unknown): void {
    const layout = requiredLibLayout(state);
    state.libValue = value;
    const bytes = writeLayoutValue(layout, value);
    if (!state.buffer) createLibBuffer(state, layout.size);
    state.bytes = bytes;
    state.buffer!.write(bytes, 0);
  }

  function setUserOwned(state: MutableBindingState, value: unknown): void {
    const normalized = normalizeResource(state.info, value, { sourceHint: options.label });
    state.resource = normalized.resource;
    state.identity = normalized.identity;
    state.unsubscribe?.();
    state.unsubscribe = normalized.unsubscribe?.(() => options.cache.evictIdentity(normalized.identity));
  }

  function claimGroup(group: number, bindGroup: GPUBindGroup, expectedLayout: GPUBindGroupLayout): string | undefined {
    layout(group);
    validateClaimedGroup(options.label, group, bindGroup, expectedLayout);
    const previousIdentity = claimedGroups.has(group) ? `claimed-group:${group}` : undefined;
    claimedGroups.set(group, bindGroup);
    return previousIdentity;
  }

  function layout(group: number): GPUBindGroupLayout {
    const bgl = options.bindGroupLayouts.get(group);
    if (!bgl) throw unsupportedError(`${options.label}.layout`, `No existe @group(${group}) en '${options.label}'.`);
    return bgl;
  }

  function bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } }[] {
    return groups.map(bindGroupFor);
  }

  function bindGroupFor(group: number): { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[]; readonly claimValidation?: { readonly label: string; readonly group: number } } {
    const claimed = claimedGroups.get(group);
    if (claimed) return { group, bindGroup: claimed, offsets: [], claimValidation: rawClaimValidation(claimed, group) };
    const groupBindings = options.reflection.bindings.filter((binding) => binding.group === group);
    const entries = bindGroupEntries(groupBindings);
    const identities = identitiesFor(groupBindings);
    const bindGroup = options.cache.getOrCreate(options.drawId, group, identities, () => options.device.gpu.createBindGroup({
      label: `${options.label}.group${group}`,
      layout: layout(group),
      entries,
    }));
    return { group, bindGroup, offsets: [] };
  }

  function rawClaimValidation(bindGroup: GPUBindGroup, group: number): { readonly label: string; readonly group: number } | undefined {
    return bindGroupMetadataFor(bindGroup) ? undefined : { label: options.label, group };
  }

  function bindGroupEntries(groupBindings: readonly BindingInfo[]): GPUBindGroupEntry[] {
    return groupBindings.map((binding) => {
      const state = requiredState(binding);
      return { binding: binding.binding, resource: state.resource! };
    });
  }

  function identitiesFor(groupBindings: readonly BindingInfo[]): BindGroupIdentityPart[] {
    return groupBindings.map((binding) => requiredState(binding).identity!);
  }

  function requiredState(binding: BindingInfo): MutableBindingState {
    const state = bindings.get(binding.name);
    if (!state?.resource || !state.identity) throw neverSetError(options.label, binding);
    return state;
  }

  function ensureGroupSettable(group: number): void {
    if (claimedGroups.has(group)) throw claimedGroupSetError(options.label, group);
  }

  function createLibBuffer(state: MutableBindingState, size: number): void {
    state.buffer = options.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label: `${options.label}.${state.info.name}` });
    state.resource = { buffer: state.buffer.gpu, offset: 0, size };
    state.identity = state.buffer.resourceIdentity;
    state.unsubscribe = state.buffer.onDestroy(() => options.cache.evictIdentity(state.buffer!.resourceIdentity));
  }

  function requiredLibLayout(state: MutableBindingState): NonNullable<BindingInfo["layout"]> & { readonly size: number } {
    if (state.info.kind !== "buffer" || !state.info.layout?.size) throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' no acepta valores JS planos; pasá un recurso compatible.`);
    return state.info.layout as NonNullable<BindingInfo["layout"]> & { readonly size: number };
  }

  return {
    get groups() { return groups; },
    set,
    claimGroup,
    layout,
    bindGroups,
    bindingState(name) {
      const state = bindings.get(name);
      if (!state?.ownership || !state.resource || !state.identity) return undefined;
      return { info: state.info, ownership: state.ownership, resource: state.resource, identity: state.identity };
    },
  };
}

function initializeBindings(reflection: Reflection): Map<string, MutableBindingState> {
  return new Map(reflection.bindings.map((binding) => [binding.name, { info: binding, memberOwnership: new Map() }]));
}

function reflectedGroups(reflection: Reflection): readonly number[] {
  return [...new Set(reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
}

function findMemberBinding(memberName: string, bindings: ReadonlyMap<string, MutableBindingState>, label: string): MutableBindingState | undefined {
  let match: MutableBindingState | undefined;
  for (const state of bindings.values()) {
    if (!state.info.layout?.members?.some((member) => member.name === memberName)) continue;
    if (match) throw unsupportedError(`${label}.set`, `Binding member '${memberName}' es ambiguo en '${label}'; seteá el binding completo.`);
    match = state;
  }
  return match;
}

function ownershipFor(binding: BindingInfo, value: unknown): BindingOwnership {
  return binding.bindingLayout?.kind === "buffer" && isPlainValue(value) ? "lib" : "user";
}

function latchBindingOwnership(state: MutableBindingState, name: string, ownership: BindingOwnership): void {
  if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(name, state.ownership);
  state.ownership ??= ownership;
}

function latchMemberOwnership(state: MutableBindingState, memberName: string, ownership: BindingOwnership): void {
  const previous = state.memberOwnership.get(memberName);
  if (previous && previous !== ownership) throw ownershipFlipError(memberName, previous);
  state.memberOwnership.set(memberName, ownership);
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
  if (expected.length !== claimed.length) return `esperaba ${expected.length} bindings y recibió ${claimed.length}`;
  const expectedByBinding = entriesByBinding(expected);
  const claimedByBinding = entriesByBinding(claimed);
  for (const [binding, entry] of expectedByBinding) {
    const claimedEntry = claimedByBinding.get(binding);
    if (!claimedEntry) return `falta @binding(${binding})`;
    if (entrySignature(entry) !== entrySignature(claimedEntry)) return `@binding(${binding}) no coincide con el layout reflejado`;
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

export { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, pipelineLayoutFor } from "./set-layouts.ts";
export { writeLayoutValue } from "./set-packing.ts";
