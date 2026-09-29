import type { Reflection } from "../runtime/reflect-source.ts";
import type { ShaderEntryPoint, ShaderReflection, WorkgroupAxis } from "../types.ts";

export function serializeReflection(reflection: Reflection): ShaderReflection {
  return {
    bindings: cloneData(reflection.bindings),
    entryPoints: reflection.entryPoints.map(serializeEntryPoint),
    overrides: cloneData(reflection.overrides),
    featuresRequired: [...reflection.featuresRequired],
    aliases: cloneData(reflection.aliases),
    structs: cloneData(reflection.structs),
    hostShareableLayouts: cloneData(reflection.hostShareableLayouts),
  };
}

function serializeEntryPoint(entry: Reflection["entryPoints"][number]): ShaderEntryPoint {
  return {
    name: entry.name,
    mangledName: entry.mangledName,
    stage: entry.stage,
    ...(entry.workgroupSize
      ? { workgroupSize: entry.workgroupSize.map(serializeWorkgroupAxis) as [WorkgroupAxis, WorkgroupAxis, WorkgroupAxis] }
      : {}),
    bindings: cloneData(entry.bindings ?? []),
    samplingPairs: cloneData(entry.samplingPairs ?? []),
    ...(entry.inputs ? { inputs: cloneData(entry.inputs) } : {}),
  };
}

function serializeWorkgroupAxis(value: number): WorkgroupAxis {
  return Number.isFinite(value) ? value : "unresolved";
}

function cloneData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneData) as T;
  if (typeof value !== "object" || value === null) return value;

  const result: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    if (nested !== undefined) result[key] = cloneData(nested);
  }
  return result as T;
}
