import type { MangleModule } from "./mangler.ts";

export interface Reflection {
  readonly bindings: readonly BindingInfo[];
  readonly entryPoints: readonly EntryPointInfo[];
  readonly overrides: readonly OverrideInfo[];
  readonly featuresRequired: readonly string[];
  readonly hostShareableLayouts: readonly [];
}
export interface BindingInfo { readonly group: number; readonly binding: number; readonly name: string }
export interface EntryPointInfo { readonly name: string; readonly mangledName: string; readonly stage: "vertex" | "fragment" | "compute" }
export interface OverrideInfo { readonly name: string; readonly mangledName: string; readonly defaultValue?: string }

export function reflect(modules: readonly MangleModule[]): Reflection {
  const bindings: BindingInfo[] = [];
  const entryPoints: EntryPointInfo[] = [];
  const overrides: OverrideInfo[] = [];
  const featuresRequired: string[] = [];
  for (const module of modules) {
    for (const match of module.source.matchAll(/@group\((\d+)\)\s*@binding\((\d+)\)[\s\S]*?var(?:<[^>]+>)?\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      bindings.push({ group: Number(match[1]), binding: Number(match[2]), name: match[3]! });
    }
    for (const match of module.source.matchAll(/@(vertex|fragment|compute)[\s\S]*?fn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const stage = match[1] as "vertex" | "fragment" | "compute";
      entryPoints.push({ stage, name: match[2]!, mangledName: match[2]! });
    }
    for (const match of module.source.matchAll(/\boverride\s+([A-Za-z_][A-Za-z0-9_]*)(?:[^=;]*=\s*([^;]+))?/g)) {
      overrides.push({ name: match[1]!, mangledName: match[1]!, defaultValue: match[2]?.trim() });
    }
    for (const match of module.source.matchAll(/\benable\s+([A-Za-z_][A-Za-z0-9_]*)\s*;/g)) featuresRequired.push(match[1]!);
  }
  return { bindings, entryPoints, overrides, featuresRequired, hostShareableLayouts: [] };
}
