import type { MetalUniform, UniformFieldType } from "../index.js";
import type { SemanticResult } from "./protocol.js";
import { MetalCompileError } from "./errors.js";
import { canonicalJSON, sha256 } from "./source.js";
import { validateSwiftIdentifier } from "../validation.js";

export interface MetalBindingMapping {
  group: number;
  binding: number;
  slots: {
    mode: "direct";
    resourceClass: "buffer";
    component: "buffer";
    index: number;
    count: 1;
  }[];
}
interface Binding {
  id: string;
  name: string;
  group: number;
  binding: number;
  kind: string;
  addressSpace?: string;
  access?: string;
  type: string;
  layout: string;
  minimumBindingSize: number;
}
interface Type {
  kind: string;
  scalar?: string;
  width?: number;
  element?: string;
  wgslName?: string;
  members?: { name: string; type: string }[];
}
interface LayoutMember {
  name: string;
  type: string;
  layout: string;
  offset: number;
  alignment: number;
  minimumSize: number;
  size?: number;
  runtimeSized: boolean;
}
interface Layout {
  type: string;
  alignment: number;
  minimumSize: number;
  size?: number;
  runtimeSized: boolean;
  members: LayoutMember[];
  arrayStride?: number;
  elementLayout?: string;
  matrixStride?: number;
}

/** Project checked worker metadata; resolver reflection supplies authored names only. */
export function projectUniforms(
  semantics: SemanticResult,
  authoredStructs: readonly { name: string; mangledName: string }[]
): {
  uniforms: MetalUniform[];
  stages: Record<"vertex" | "fragment", MetalBindingMapping[]>;
} {
  const bindings = semantics.bindings as Binding[];
  const types = semantics.types as Record<string, Type>;
  const layouts = semantics.layouts as Record<string, Layout>;
  for (const [id, type] of Object.entries(types)) {
    if (
      id !==
      `t_${sha256(`vgpu-native-semantic-type/v1\0${canonicalJSON(type)}`)}`
    )
      fail("type content identity does not match");
  }
  for (const [id, layout] of Object.entries(layouts)) {
    if (
      id !==
      `l_${sha256(`vgpu-native-semantic-layout/v1\0${canonicalJSON(layout)}`)}`
    )
      fail("layout content identity does not match");
  }
  const stages: Record<"vertex" | "fragment", MetalBindingMapping[]> = {
    vertex: [],
    fragment: [],
  };
  const slots = new Map<
    string,
    { stage: "vertex" | "fragment"; index: number }[]
  >();
  const byId = new Map(bindings.map((binding) => [binding.id, binding]));
  if (byId.size !== bindings.length) fail("duplicate binding identities");
  const bindingNames = new Set<string>();
  for (const binding of bindings) {
    if (binding.id !== `g${binding.group}b${binding.binding}`)
      fail("binding coordinate identity does not match");
    if (
      binding.kind !== "buffer" ||
      binding.addressSpace !== "uniform" ||
      binding.access !== "read"
    )
      fail("resource bindings must be fixed uniform buffers");
    validateName(binding.name, "uniform binding name");
    if (bindingNames.has(binding.name.toLowerCase()))
      fail("duplicate uniform binding name");
    bindingNames.add(binding.name.toLowerCase());
  }
  for (const entry of semantics.entryPoints) {
    if (entry.stage === "compute")
      fail("render uniform projection requires render stages");
    if (entry.samplingPairs.length) fail("sampling pairs are unsupported");
    const active = entry.bindings
      .map((id) => {
        const binding = byId.get(id);
        if (!binding) fail("selected stage refers to a missing binding");
        return binding;
      })
      .sort((a, b) => a.group - b.group || a.binding - b.binding);
    if (active.length > 30)
      fail("stage exceeds the supported 30 direct buffer slots");
    stages[entry.stage] = active.map((binding, index) => {
      slots.set(binding.id, [
        ...(slots.get(binding.id) ?? []),
        { stage: entry.stage, index },
      ]);
      return {
        group: binding.group,
        binding: binding.binding,
        slots: [
          {
            mode: "direct",
            resourceClass: "buffer",
            component: "buffer",
            index,
            count: 1,
          },
        ],
      };
    });
  }
  if (slots.size !== bindings.length)
    fail("binding table differs from selected stage usage");
  const uniforms = bindings.map((binding): MetalUniform => {
    const type = types[binding.type];
    const layout = layouts[binding.layout];
    if (
      !type ||
      type.kind !== "struct" ||
      !type.members ||
      !layout ||
      layout.type !== binding.type
    )
      fail("uniform requires a reflected struct and matching root layout");
    fixed(layout);
    if (layout.size % layout.alignment !== 0)
      fail("uniform root size does not include alignment padding");
    if (
      layout.size !== binding.minimumBindingSize ||
      layout.members.length !== type.members.length
    )
      fail("uniform size or member graph does not match");
    const names = authoredStructs.filter(
      (candidate) => candidate.mangledName === type.wgslName
    );
    if (names.length !== 1) fail("uniform type has no unique authored name");
    validateName(names[0].name, "uniform type name");
    let end = 0;
    const memberNames = new Set<string>();
    const members = type.members.map((member, index) => {
      validateName(member.name, "uniform member name");
      if (memberNames.has(member.name.toLowerCase()))
        fail("duplicate uniform member name");
      memberNames.add(member.name.toLowerCase());
      const physical = layout.members[index];
      if (physical.name !== member.name || physical.type !== member.type)
        fail("uniform logical and physical members differ");
      const child = layouts[physical.layout];
      if (!child || child.type !== member.type)
        fail("uniform member layout does not match its type");
      fixed(child);
      const childType = types[member.type];
      let fieldType: UniformFieldType;
      let width: number;
      if (childType?.kind === "scalar" && childType.scalar === "f32") {
        fieldType = "f32";
        width = 1;
      } else if (
        childType?.kind === "vector" &&
        [2, 3, 4].includes(childType.width!) &&
        types[childType.element!]?.kind === "scalar" &&
        types[childType.element!]?.scalar === "f32"
      ) {
        width = childType.width!;
        fieldType = `vec${width}f` as UniformFieldType;
      } else fail("uniform supports only flat f32/vector members");
      const intrinsicAlignment = width === 3 ? 16 : width * 4;
      if (
        child.size !== width * 4 ||
        child.alignment !== intrinsicAlignment ||
        child.members.length
      )
        fail("uniform leaf layout is inconsistent");
      if (!Number.isInteger(Math.log2(physical.alignment)))
        fail("uniform contextual alignment must be a power of two");
      if (layout.alignment < physical.alignment)
        fail("uniform root alignment does not cover its member");
      if (
        physical.runtimeSized ||
        physical.size === undefined ||
        physical.minimumSize !== physical.size ||
        physical.size < child.size ||
        physical.alignment < child.alignment ||
        physical.offset % physical.alignment !== 0 ||
        physical.offset < end ||
        physical.offset > layout.size ||
        physical.size > layout.size - physical.offset
      )
        fail("uniform contextual member range is inconsistent");
      end = physical.offset + physical.size;
      return { name: member.name, type: fieldType, offset: physical.offset };
    });
    return {
      name: binding.name,
      typeName: names[0].name,
      byteCount: layout.size,
      alignment: layout.alignment,
      members,
      slots: slots.get(binding.id)!,
    };
  });
  return { uniforms, stages };
}

function fixed(layout: Layout): asserts layout is Layout & { size: number } {
  if (
    layout.runtimeSized ||
    layout.size === undefined ||
    layout.minimumSize !== layout.size ||
    layout.arrayStride !== undefined ||
    layout.elementLayout !== undefined ||
    layout.matrixStride !== undefined
  )
    fail("uniform requires a fixed flat layout");
  if (layout.size <= 0 || layout.size > 0xffffffff)
    fail("uniform layout size must be a positive uint32");
  if (!Number.isInteger(Math.log2(layout.alignment)))
    fail("uniform layout alignment must be a power of two");
}
function validateName(name: string, label: string): void {
  try {
    validateSwiftIdentifier(name, label);
  } catch (cause) {
    throw new MetalCompileError(
      "validation",
      `Unsupported uniform metadata: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause }
    );
  }
}
function fail(message: string): never {
  throw new MetalCompileError(
    "validation",
    `Unsupported uniform metadata: ${message}`
  );
}
