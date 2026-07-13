import { type Buffer, type Device, type UnsubscribeResourceDestroy } from "@vgpu/core";
import type { BindingInfo, Reflection } from "@vgpu/wgsl/runtime";
import type { BindGroupCache, BindGroupIdentityPart } from "./bind-cache.ts";
import { claimedGroupSetError, neverSetError, ownershipFlipError, unsupportedError } from "./errors.ts";
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

/** Ring-1 set() engine: latches ownership, validates completeness, and returns cached bind groups. */
export interface SetCore {
  readonly groups: readonly number[];
  set(values: SetBag): void;
  claimGroup(group: number, bindGroup: GPUBindGroup): void;
  layout(group: number): GPUBindGroupLayout;
  bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[] }[];
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


export function createSetCore(options: SetCoreOptions): SetCore {
  const bindings = new Map<string, MutableBindingState>();
  const groups = [...new Set(options.reflection.bindings.map((binding) => binding.group))].sort((a, b) => a - b);
  const claimedGroups = new Map<number, GPUBindGroup>();

  for (const binding of options.reflection.bindings) bindings.set(binding.name, { info: binding, memberOwnership: new Map() });

  function set(values: SetBag): void {
    for (const [name, value] of Object.entries(values)) {
      const direct = bindings.get(name);
      if (direct) {
        setBinding(direct, name, value);
        continue;
      }
      const member = findMemberBinding(name);
      if (!member) throw unsupportedError(`${options.label}.set`, `Binding '${name}' no existe en '${options.label}'.`);
      setBindingMember(member, name, value);
    }
  }

  function setBinding(state: MutableBindingState, name: string, value: unknown): void {
    if (claimedGroups.has(state.info.group)) throw claimedGroupSetError(options.label, state.info.group);
    const ownership = isPlainValue(value) ? "lib" : "user";
    if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(name, state.ownership);
    state.ownership ??= ownership;
    if (ownership === "lib") setLibOwned(state, mergeLibValue(state.libValue, value));
    else setUserOwned(state, value);
  }

  function setBindingMember(state: MutableBindingState, memberName: string, value: unknown): void {
    if (claimedGroups.has(state.info.group)) throw claimedGroupSetError(options.label, state.info.group);
    const ownership = isPlainValue(value) ? "lib" : "user";
    if (state.ownership && state.ownership !== ownership) throw ownershipFlipError(memberName, state.ownership);
    state.ownership ??= ownership;
    const previousMemberOwnership = state.memberOwnership.get(memberName);
    if (previousMemberOwnership && previousMemberOwnership !== ownership) throw ownershipFlipError(memberName, previousMemberOwnership);
    state.memberOwnership.set(memberName, ownership);
    if (ownership !== "lib") throw unsupportedError(`${options.label}.set`, `Binding member '${memberName}' no puede recibir recursos; seteá el binding completo '${state.info.name}'.`);
    setLibOwned(state, { ...objectValue(state.libValue), [memberName]: value });
  }

  function findMemberBinding(memberName: string): MutableBindingState | undefined {
    let match: MutableBindingState | undefined;
    for (const state of bindings.values()) {
      if (!state.info.layout?.members?.some((member) => member.name === memberName)) continue;
      if (match) throw unsupportedError(`${options.label}.set`, `Binding member '${memberName}' es ambiguo en '${options.label}'; seteá el binding completo.`);
      match = state;
    }
    return match;
  }

  function mergeLibValue(previous: unknown, value: unknown): unknown {
    if (isPlainObject(previous) && isPlainObject(value)) return { ...previous, ...value };
    return value;
  }

  function objectValue(value: unknown): Record<string, unknown> {
    return isPlainObject(value) ? value : {};
  }

  function setLibOwned(state: MutableBindingState, value: unknown): void {
    if (state.info.kind !== "buffer" || !state.info.layout?.size) {
      throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' no acepta valores JS planos; pasá un recurso compatible.`);
    }
    const layout = state.info.layout;
    state.libValue = value;
    const bytes = writeLayoutValue(layout, value);
    if (!state.buffer) {
      const size = layout.size;
      if (size === undefined) throw unsupportedError(`${options.label}.set`, `Binding '${state.info.name}' tiene tamaño runtime y no acepta empaquetado automático.`);
      state.buffer = options.device.createBuffer({ size, usage: ["uniform", "copy_dst"], label: `${options.label}.${state.info.name}` });
      state.resource = { buffer: state.buffer.gpu, offset: 0, size };
      state.identity = state.buffer.resourceIdentity;
      state.unsubscribe = state.buffer.onDestroy(() => options.cache.evictIdentity(state.buffer!.resourceIdentity));
    }
    state.bytes = bytes;
    state.buffer.write(bytes, 0);
  }

  function setUserOwned(state: MutableBindingState, value: unknown): void {
    const normalized = normalizeResource(value);
    state.resource = normalized.resource;
    state.identity = normalized.identity;
    state.unsubscribe?.();
    state.unsubscribe = normalized.unsubscribe?.(() => options.cache.evictIdentity(normalized.identity));
  }

  function claimGroup(group: number, bindGroup: GPUBindGroup): void {
    claimedGroups.set(group, bindGroup);
  }

  function layout(group: number): GPUBindGroupLayout {
    const bgl = options.bindGroupLayouts.get(group);
    if (!bgl) throw unsupportedError(`${options.label}.layout`, `No existe @group(${group}) en '${options.label}'.`);
    return bgl;
  }

  function bindGroups(): readonly { readonly group: number; readonly bindGroup: GPUBindGroup; readonly offsets: readonly number[] }[] {
    const result: { group: number; bindGroup: GPUBindGroup; offsets: readonly number[] }[] = [];
    for (const group of groups) {
      const claimed = claimedGroups.get(group);
      if (claimed) {
        result.push({ group, bindGroup: claimed, offsets: [] });
        continue;
      }
      const groupBindings = options.reflection.bindings.filter((binding) => binding.group === group);
      const entries: GPUBindGroupEntry[] = [];
      const identities: BindGroupIdentityPart[] = [];
      for (const binding of groupBindings) {
        const state = bindings.get(binding.name);
        if (!state?.resource || !state.identity) throw neverSetError(options.label, binding);
        entries.push({ binding: binding.binding, resource: state.resource });
        identities.push(state.identity);
      }
      const bgl = layout(group);
      const bindGroup = options.cache.getOrCreate(options.drawId, group, identities, () => options.device.gpu.createBindGroup({
        label: `${options.label}.group${group}`,
        layout: bgl,
        entries,
      }));
      result.push({ group, bindGroup, offsets: [] });
    }
    return result;
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

export { bindGroupLayoutEntriesForGroup, bindGroupLayoutsForReflection, pipelineLayoutFor } from "./set-layouts.ts";
export { writeLayoutValue } from "./set-packing.ts";
