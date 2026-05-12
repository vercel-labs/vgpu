import { invalidUsage } from "../uniform-pool-internals.ts";
import { DEFAULT_MATERIAL_SAMPLER, isTextureKind, textureWgslType, type MaterialSamplerSpec, type MaterialTextureSpec } from "./material-textures-schema.ts";
import type { MaterialSpec } from "./material-factory.ts";
import type { WgslUniformType } from "./wgsl-alignment.ts";

export interface MaterialBindingAllocation<T extends Record<string, MaterialTextureSpec>> {
  readonly textureBindings: Readonly<Record<keyof T, number>>;
  readonly samplerBindings: Readonly<Record<string, number>>;
}

/**
 * Allocates material binding numbers without touching GPU state.
 *
 * Binding allocation order is a public stability contract: uniforms first
 * (binding 0 when present), then samplers, then textures, each in insertion
 * order. When an implicit `materialSampler` is needed, it is allocated before
 * explicit sampler keys so existing implicit-texture materials keep binding 0.
 */
export function allocateMaterialBindings<T extends Record<string, MaterialTextureSpec>, S extends Record<string, MaterialSamplerSpec>>(
  textures: T | undefined,
  samplers: S | undefined,
  firstBinding: number,
): MaterialBindingAllocation<T> {
  const samplerBindings = Object.fromEntries(samplerNames(textures, samplers).map((name, index) => [name, firstBinding + index]));
  const textureFirst = firstBinding + Object.keys(samplerBindings).length;
  const textureBindings = Object.fromEntries(Object.keys(textures ?? {}).map((name, index) => [name, textureFirst + index])) as Readonly<Record<keyof T, number>>;
  return { textureBindings, samplerBindings };
}

/**
 * Returns the WGSL `@group/@binding var ...` lines that `material()` prepends
 * when `autoDeclarations: true`, without creating GPU resources.
 *
 * The returned string covers textures and samplers only, not the `Uniforms`
 * struct. Binding allocation order is uniforms → samplers → textures, each in
 * insertion order. Textures that omit a sampler key use the implicit
 * `materialSampler`, which is allocated before explicit sampler keys to
 * preserve Chunk 2 numbering. The string is byte-identical to what `material()`
 * prepends for the same spec when `autoDeclarations: true`.
 *
 * @example
 * ```ts
 * const decls = getMaterialDeclarations(spec);
 * const mat = material({ ...spec, fragment: `${decls}\n${spec.fragment}` });
 * ```
 */
export function getMaterialDeclarations<
  U extends Record<string, WgslUniformType>,
  T extends Record<string, MaterialTextureSpec>,
  S extends Record<string, MaterialSamplerSpec>,
>(spec: Pick<MaterialSpec<U, T, S>, "uniforms" | "textures" | "samplers">): string {
  const firstBinding = Object.keys(spec.uniforms ?? {}).length === 0 ? 0 : 1;
  const allocation = allocateMaterialBindings(spec.textures, spec.samplers, firstBinding);
  return wgslDeclarations(spec.textures, allocation.textureBindings, allocation.samplerBindings);
}

/**
 * Emits WGSL texture and sampler declarations from pre-computed binding maps.
 *
 * Use this lower-level helper when you already have binding maps, for example
 * from `mat.textureBindings` and `mat.samplerBindings`. Binding allocation order
 * for maps produced by `material()` / `getMaterialDeclarations()` is uniforms →
 * samplers → textures, each in insertion order.
 *
 * @example
 * ```ts
 * const decls = wgslDeclarations(spec.textures, mat.textureBindings, mat.samplerBindings);
 * const visibleFragment = `${decls}\n${fragment}`;
 * ```
 */
export function wgslDeclarations<T extends Record<string, MaterialTextureSpec>>(
  textures: T | undefined,
  textureBindings: Readonly<Record<keyof T, number>>,
  samplerBindings: Readonly<Record<string, number>>,
  group = 0,
): string {
  const fields = Object.entries(textures ?? {}).map(([name, spec]) => textureField(name, spec, textureBindings[name]));
  if (fields.length === 0) return "";
  const emitted = new Set<string>();
  const lines: string[] = [];
  for (const field of fields) {
    lines.push(`@group(${group}) @binding(${field.binding}) var ${field.name}: ${textureWgslType(field.kind)};`);
    const sampler = field.sampler ?? (DEFAULT_MATERIAL_SAMPLER in samplerBindings ? DEFAULT_MATERIAL_SAMPLER : undefined);
    if (sampler && !emitted.has(sampler)) emitSampler(lines, emitted, sampler, samplerBindings, group);
  }
  for (const sampler of Object.keys(samplerBindings)) emitSampler(lines, emitted, sampler, samplerBindings, group);
  return lines.join("\n");
}

export function samplerNames(textures: unknown, samplers: Record<string, MaterialSamplerSpec> | undefined): readonly string[] {
  return [...(needsDefaultSampler(textures, samplers) ? [DEFAULT_MATERIAL_SAMPLER] : []), ...Object.keys(samplers ?? {})];
}

function emitSampler(lines: string[], emitted: Set<string>, name: string, bindings: Readonly<Record<string, number>>, group: number): void {
  const binding = bindings[name];
  if (binding === undefined || emitted.has(name)) return;
  lines.push(`@group(${group}) @binding(${binding}) var ${name}: sampler;`);
  emitted.add(name);
}

function textureField(name: string, spec: MaterialTextureSpec, binding: number | undefined) {
  const kind = typeof spec === "string" ? spec : spec?.kind;
  if (!isTextureKind(kind)) throw invalidUsage("material", `Unsupported texture kind for '${name}'.`);
  if (binding === undefined) throw invalidUsage("material", `Missing texture binding for '${name}'.`);
  return { name, kind, binding, sampler: typeof spec === "string" ? undefined : spec.sampler };
}

function needsDefaultSampler(textures: unknown, samplers: Record<string, MaterialSamplerSpec> | undefined): boolean {
  return Object.values((textures ?? {}) as Record<string, MaterialTextureSpec>).some((spec) => typeof spec !== "object" || spec === null || !spec.sampler) && !(DEFAULT_MATERIAL_SAMPLER in (samplers ?? {}));
}
