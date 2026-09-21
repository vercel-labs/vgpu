import type { MetalCompute, MetalStorage } from "../index.js";
import type { SemanticResult } from "./protocol.js";
import type { MetalBindingMapping } from "./uniforms.js";
import { MetalCompileError } from "./errors.js";
import { canonicalJSON, sha256 } from "./source.js";
import { validateSwiftIdentifier } from "../validation.js";

interface StorageBinding {
  id: string;
  name: string;
  group: number;
  binding: number;
  kind: string;
  addressSpace: string;
  access: "read" | "read_write";
  type: string;
  layout: string;
  minimumBindingSize: number;
}

interface StorageType {
  kind: string;
  scalar?: string;
  element?: string;
  width?: number;
  columns?: number;
  rows?: number;
  count?: number;
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

interface StorageLayout {
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

export function projectComputeStorage(semantics: SemanticResult): {
  storage: MetalStorage[];
  bindings: MetalBindingMapping[];
  workgroupSize: MetalCompute["workgroupSize"];
} {
  const types = semantics.types as Record<string, StorageType>;
  const layouts = semantics.layouts as Record<string, StorageLayout>;
  for (const [id, type] of Object.entries(semantics.types)) {
    if (
      id !==
      `t_${sha256(`vgpu-native-semantic-type/v1\0${canonicalJSON(type)}`)}`
    )
      fail("type content identity does not match");
  }
  for (const [id, layout] of Object.entries(semantics.layouts)) {
    if (
      id !==
      `l_${sha256(`vgpu-native-semantic-layout/v1\0${canonicalJSON(layout)}`)}`
    )
      fail("layout content identity does not match");
  }
  const entry = semantics.entryPoints[0];
  if (
    semantics.entryPoints.length !== 1 ||
    entry.stage !== "compute" ||
    entry.semanticInterface.kind !== "compute"
  )
    fail("requires one compute entry");
  if (entry.samplingPairs.length) fail("sampling pairs are unsupported");
  if (entry.overrides.length || semantics.overrides.length)
    fail("active overrides are unsupported");
  const seenBuiltins = new Set<string>();
  const builtins = new Set([
    "local_invocation_id",
    "local_invocation_index",
    "global_invocation_id",
    "workgroup_id",
    "num_workgroups",
  ]);
  for (const input of entry.semanticInterface.inputs) {
    if (
      !input.builtin ||
      !builtins.has(input.builtin) ||
      seenBuiltins.has(input.builtin) ||
      input.type.scalar !== "u32" ||
      input.type.width !== (input.builtin === "local_invocation_index" ? 1 : 3)
    )
      fail("compute builtin identity or type is invalid");
    seenBuiltins.add(input.builtin);
  }
  const bindings = [...(semantics.bindings as StorageBinding[])].sort(
    (a, b) => a.group - b.group || a.binding - b.binding
  );
  const ids = new Set(bindings.map(({ id }) => id));
  if (ids.size !== bindings.length) fail("duplicate binding identities");
  if (bindings.length > 30)
    fail("compute exceeds the supported 30 direct buffer slots");
  const names = new Set<string>();
  for (const binding of bindings) {
    if (binding.id !== `g${binding.group}b${binding.binding}`)
      fail("binding coordinate identity does not match");
    if (
      binding.kind !== "buffer" ||
      binding.addressSpace !== "storage" ||
      !["read", "read_write"].includes(binding.access)
    )
      fail("resources must be read or read_write storage buffers");
    try {
      validateSwiftIdentifier(binding.name, "storage binding name");
    } catch (cause) {
      throw new MetalCompileError(
        "validation",
        `Unsupported compute storage metadata: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        { cause }
      );
    }
    if (names.has(binding.name.toLowerCase()))
      fail("duplicate storage binding name");
    names.add(binding.name.toLowerCase());
  }
  if (
    entry.bindings.length !== bindings.length ||
    new Set(entry.bindings).size !== entry.bindings.length ||
    entry.bindings.some((id) => !ids.has(id))
  )
    fail("binding table differs from selected binding union");
  const verifiedLayouts = new Set<string>();
  return {
    workgroupSize: { ...entry.workgroupSize },
    storage: bindings.map((binding, index) => {
      const layout = visit(binding.type, binding.layout);
      const tail =
        layout.arrayStride !== undefined
          ? layout
          : layouts[layout.members.at(-1)?.layout ?? ""];
      // A runtime layout's minimumSize is its zero-element footprint. The
      // binding minimum additionally includes one element and root padding.
      const minimum = layout.runtimeSized
        ? roundUp(layout.alignment, layout.minimumSize + tail.arrayStride!)
        : layout.size;
      if (
        !positiveUint32(binding.minimumBindingSize) ||
        binding.minimumBindingSize !== minimum
      )
        fail("minimum binding size does not match its physical root");
      return {
        name: binding.name,
        access: binding.access,
        minimumBindingSize: binding.minimumBindingSize,
        alignment: layout.alignment,
        runtimeSized: layout.runtimeSized,
        slots: [{ stage: "compute", index }],
      };
    }),
    bindings: bindings.map((binding, index) => ({
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
    })),
  };

  function visit(
    typeId: string,
    layoutId: string,
    allowRuntime = true,
    depth = 0
  ): StorageLayout {
    if (depth > 64) fail("storage graph nesting exceeds 64");
    const type = types[typeId];
    const layout = layouts[layoutId];
    if (!type) fail("missing semantic type");
    if (!layout) fail("missing physical layout");
    if (!["scalar", "vector", "matrix", "array", "struct"].includes(type.kind))
      fail("unsupported storage type");
    if (layout.type !== typeId)
      fail("physical layout does not match its semantic type");
    if (layout.runtimeSized && !allowRuntime)
      fail("runtime array must be the storage root or its final direct member");
    // Shared fixed subgraphs are checked once, avoiding exponential traversal.
    if (verifiedLayouts.has(layoutId)) return layout;
    if (
      !positiveUint32(layout.alignment) ||
      !Number.isInteger(Math.log2(layout.alignment))
    )
      fail("physical layout alignment must be a uint32 power of two");
    if (
      !uint32(layout.minimumSize) ||
      (!layout.runtimeSized &&
        (!positiveUint32(layout.size) || layout.minimumSize !== layout.size))
    )
      fail("physical layout extent is inconsistent or exceeds uint32");
    if (type.element !== undefined && !types[type.element])
      fail("missing element type");
    if (type.kind === "scalar") {
      if (!["f32", "i32", "u32"].includes(type.scalar!))
        fail("unsupported storage scalar type");
      if (
        layout.runtimeSized ||
        layout.size !== 4 ||
        layout.alignment !== 4 ||
        layout.members.length ||
        layout.arrayStride !== undefined ||
        layout.matrixStride !== undefined
      )
        fail("numeric leaf layout is inconsistent");
    }
    if (type.kind === "vector" || type.kind === "matrix") {
      const scalar = types[type.element!];
      if (
        scalar.kind !== "scalar" ||
        !["f32", "i32", "u32"].includes(scalar.scalar!) ||
        (type.kind === "matrix" && scalar.scalar !== "f32")
      )
        fail("unsupported numeric element type");
      const width = type.kind === "vector" ? type.width! : type.rows!;
      const alignment = (width === 3 ? 4 : width) * 4;
      const size =
        type.kind === "vector" ? width * 4 : type.columns! * alignment;
      if (
        layout.runtimeSized ||
        layout.size !== size ||
        layout.alignment !== alignment ||
        layout.members.length ||
        layout.arrayStride !== undefined ||
        layout.matrixStride !== (type.kind === "matrix" ? alignment : undefined)
      )
        fail("numeric leaf layout is inconsistent");
    }
    if (type.kind === "array") {
      if (!type.element || !layout.elementLayout)
        fail("array is missing its element layout edge");
      const element = visit(
        type.element,
        layout.elementLayout,
        false,
        depth + 1
      );
      const runtime = type.count === undefined;
      if (
        element.runtimeSized ||
        element.size === undefined ||
        layout.members.length ||
        layout.matrixStride !== undefined ||
        layout.alignment !== element.alignment ||
        layout.arrayStride !== roundUp(element.alignment, element.size) ||
        layout.runtimeSized !== runtime ||
        (runtime
          ? layout.minimumSize !== 0
          : layout.size !== layout.arrayStride * type.count!)
      )
        fail("array layout stride, element, or count is inconsistent");
    }
    if (type.kind === "struct") {
      if (!type.members || type.members.length !== layout.members.length)
        fail("logical and physical struct members differ");
      if (
        new Set(type.members.map(({ name }) => name)).size !==
        type.members.length
      )
        fail("duplicate struct member identities");
      let end = 0;
      let alignment = 1;
      for (const [index, member] of type.members.entries()) {
        const physical = layout.members[index];
        if (physical.name !== member.name || physical.type !== member.type)
          fail("logical and physical struct members differ");
        const child = visit(
          member.type,
          physical.layout,
          allowRuntime &&
            index === type.members.length - 1 &&
            types[member.type]?.kind === "array",
          depth + 1
        );
        if (
          !positiveUint32(physical.alignment) ||
          !Number.isInteger(Math.log2(physical.alignment)) ||
          physical.alignment < child.alignment ||
          layout.alignment < physical.alignment ||
          !uint32(physical.offset) ||
          physical.offset !== roundUp(physical.alignment, end) ||
          !uint32(physical.minimumSize) ||
          physical.minimumSize < child.minimumSize ||
          physical.runtimeSized !== child.runtimeSized ||
          (physical.runtimeSized
            ? physical.minimumSize !== child.minimumSize
            : physical.size !== physical.minimumSize) ||
          physical.offset > layout.minimumSize ||
          physical.minimumSize > layout.minimumSize - physical.offset
        )
          fail("struct contextual member extent or alignment is inconsistent");
        end = physical.offset + physical.minimumSize;
        alignment = Math.max(alignment, physical.alignment);
      }
      const runtime = layout.members.at(-1)!.runtimeSized;
      if (
        layout.arrayStride !== undefined ||
        layout.matrixStride !== undefined ||
        layout.alignment !== alignment ||
        layout.runtimeSized !== runtime ||
        layout.minimumSize !== (runtime ? end : roundUp(alignment, end))
      )
        fail("struct footprint does not match its contextual members");
    }
    verifiedLayouts.add(layoutId);
    return layout;
  }
}

function uint32(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xffffffff
  );
}
function positiveUint32(value: unknown): value is number {
  return uint32(value) && value > 0;
}
function roundUp(alignment: number, value: number): number {
  return Math.ceil(value / alignment) * alignment;
}

function fail(message: string): never {
  throw new MetalCompileError(
    "validation",
    `Unsupported compute storage metadata: ${message}`
  );
}
