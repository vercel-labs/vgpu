import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  checkedSemanticResult,
  compilerIdentity,
  semanticContract,
} from "../src/compiler/protocol.ts";
import { projectComputeStorage } from "../src/compiler/storage.ts";

// Synthetic worker responses exercise the metadata boundary, not Tint or GPU execution.
const selected = [{ stage: "compute", wgsl: "count_main" }];
const requestBytes = "synthetic compute storage request";
type RecordValue = Record<string, unknown>;

test("compute storage preserves runtime prefix and fixed output requirements in slot order", () => {
  expect(project(fixture())).toEqual({
    workgroupSize: { x: 1, y: 1, z: 1 },
    storage: [
      {
        name: "values",
        access: "read",
        minimumBindingSize: 16,
        alignment: 4,
        runtimeSized: true,
        slots: [{ stage: "compute", index: 0 }],
      },
      {
        name: "output",
        access: "read_write",
        minimumBindingSize: 8,
        alignment: 4,
        runtimeSized: false,
        slots: [{ stage: "compute", index: 1 }],
      },
    ],
    bindings: [0, 1].map((binding) => ({
      group: 0,
      binding,
      slots: [
        {
          mode: "direct",
          resourceClass: "buffer",
          component: "buffer",
          index: binding,
          count: 1,
        },
      ],
    })),
  });
});

test("compute builtin identities and types must describe valid unique WGSL inputs", () => {
  const builtin = {
    builtin: "global_invocation_id",
    type: { scalar: "u32", width: 3 },
    invariant: false,
  };
  const valid = fixture();
  valid.response.result.entryPoints[0].semanticInterface.inputs = [
    builtin,
    {
      builtin: "local_invocation_index",
      type: { scalar: "u32", width: 1 },
      invariant: false,
    },
  ];
  expect(project(valid).workgroupSize).toEqual({ x: 1, y: 1, z: 1 });
  for (const inputs of [
    [{ ...builtin, type: { scalar: "f32", width: 1 } }],
    [builtin, builtin],
  ]) {
    const invalid = fixture();
    invalid.response.result.entryPoints[0].semanticInterface.inputs = inputs;
    expect(() => project(invalid)).toThrow(/compute builtin/);
  }
});

test("storage graph content identities reject changed type and layout records", () => {
  const changedType = fixture();
  changedType.response.result.types[changedType.scalar].scalar = "i32";
  expect(() => project(changedType)).toThrow(/type content identity/);
  const changedLayout = fixture();
  changedLayout.response.result.layouts[
    changedLayout.arrayLayout
  ].arrayStride = 8;
  expect(() => project(changedLayout)).toThrow(/layout content identity/);
});

test("storage bindings are exactly the selected compute binding union", () => {
  const missing = fixture();
  missing.response.result.entryPoints[0].bindings = ["g0b0", "g0b2"];
  expect(() => project(missing)).toThrow(/selected binding union/);
  const unused = fixture();
  unused.response.result.entryPoints[0].bindings = ["g0b0"];
  expect(() => project(unused)).toThrow(/selected binding union/);
  const duplicate = fixture();
  duplicate.response.result.bindings.push({
    ...duplicate.output,
    name: "anotherOutput",
  });
  expect(() => project(duplicate)).toThrow(/binding identities/);
  const coordinate = fixture();
  coordinate.output.binding = 2;
  expect(() => project(coordinate)).toThrow(/coordinate identity/);
});

test("the compute profile accepts only named storage buffers within direct slot capacity", () => {
  const uniform = fixture();
  uniform.values.addressSpace = "uniform";
  expect(() => project(uniform)).toThrow(/storage buffers/);
  const invalidName = fixture();
  invalidName.values.name = "class";
  expect(() => project(invalidName)).toThrow(/storage binding name/);
  const duplicateName = fixture();
  duplicateName.output.name = "Values";
  expect(() => project(duplicateName)).toThrow(
    /duplicate storage binding name/
  );
  const excessive = fixture();
  excessive.response.result.bindings = Array.from(
    { length: 31 },
    (_, index) => ({
      ...excessive.output,
      id: `g0b${index}`,
      binding: index,
      name: `buffer${index}`,
    })
  );
  excessive.response.result.entryPoints[0].bindings =
    excessive.response.result.bindings.map(({ id }) => id);
  expect(() => project(excessive)).toThrow(/30 direct buffer slots/);
});

test("storage roots and every reachable layout edge must join their exact semantic type", () => {
  const root = fixture();
  root.values.layout = root.outputLayout;
  expect(() => project(root)).toThrow(/layout.*type/);
  const missingLayout = fixture();
  delete missingLayout.response.result.layouts[missingLayout.particleLayout];
  expect(() => project(missingLayout)).toThrow(/missing.*layout/);
  const missingType = fixture();
  delete missingType.response.result.types[missingType.scalar];
  expect(() => project(missingType)).toThrow(/missing.*type/);
});

test("authenticated storage layouts require power-of-two alignments and consistent fixed extents", () => {
  for (const update of [
    { alignment: 3 },
    { minimumSize: 12 },
    { minimumSize: 0, size: 0 },
    { minimumSize: 0x100000000, size: 0x100000000 },
  ]) {
    const invalid = fixture();
    Object.assign(
      invalid.response.result.layouts[invalid.outputLayout],
      update
    );
    rehashLayouts(invalid);
    expect(() => project(invalid)).toThrow(
      /physical layout (alignment|extent)/
    );
  }
});

test("fixed scalar storage layout matches its intrinsic byte size", () => {
  const invalid = fixture();
  Object.assign(invalid.response.result.layouts[invalid.scalarLayout], {
    size: 8,
    minimumSize: 8,
  });
  rehashLayouts(invalid);
  expect(() => project(invalid)).toThrow(/numeric leaf layout/);
});

test("numeric vector and matrix storage require their exact physical shape", () => {
  const vector = numericFixture(
    { kind: "vector", width: 3 },
    { alignment: 16, size: 12 }
  );
  expect(project(vector).storage[0]).toMatchObject({
    minimumBindingSize: 12,
    alignment: 16,
  });
  const matrix = numericFixture(
    { kind: "matrix", rows: 3, columns: 2 },
    { alignment: 16, size: 32, matrixStride: 16 }
  );
  expect(project(matrix).storage[0]).toMatchObject({
    minimumBindingSize: 32,
    alignment: 16,
  });
  const invalid = numericFixture(
    { kind: "matrix", rows: 3, columns: 2 },
    { alignment: 16, size: 24, matrixStride: 12 }
  );
  expect(() => project(invalid)).toThrow(/numeric leaf layout/);
});

test("array strides and fixed counts agree with their explicit element layout", () => {
  const stride = fixture();
  stride.response.result.layouts[stride.arrayLayout].arrayStride = 8;
  rehashLayouts(stride);
  expect(() => project(stride)).toThrow(/array layout/);
  const count = fixture();
  Object.assign(count.response.result.layouts[count.outputLayout], {
    size: 12,
    minimumSize: 12,
  });
  rehashLayouts(count);
  expect(() => project(count)).toThrow(/array layout/);
});

test("struct contextual member extents are non-overlapping and covered by root alignment", () => {
  for (const [index, update] of [
    [0, { alignment: 3 }],
    [0, { alignment: 8 }],
    [0, { size: 2, minimumSize: 2 }],
    [1, { offset: 4 }],
    [1, { offset: 16 }],
  ] as const) {
    const invalid = fixture();
    const members = invalid.response.result.layouts[invalid.particleLayout]
      .members as RecordValue[];
    Object.assign(members[index], update);
    rehashLayouts(invalid);
    expect(() => project(invalid)).toThrow(/contextual member/);
  }
});

test("runtime arrays may appear only at the storage root or its final direct member", () => {
  const nested = fixture();
  const type = {
    kind: "struct",
    wgslName: "Outer",
    members: [{ name: "inner", type: nested.valuesType }],
  };
  const typeId = graphId("type", type);
  const layout = {
    type: typeId,
    alignment: 4,
    minimumSize: 4,
    runtimeSized: true,
    members: [
      {
        name: "inner",
        type: nested.valuesType,
        layout: nested.valuesLayout,
        offset: 0,
        alignment: 4,
        minimumSize: 4,
        runtimeSized: true,
      },
    ],
  };
  const layoutId = graphId("layout", layout);
  nested.response.result.types[typeId] = type;
  nested.response.result.layouts[layoutId] = layout;
  Object.assign(nested.values, { type: typeId, layout: layoutId });
  expect(() => project(nested)).toThrow(/runtime array.*root/);
});

test("struct footprint and runtime status agree with the final contextual member", () => {
  const prefix = fixture();
  prefix.response.result.layouts[prefix.valuesLayout].minimumSize = 8;
  rehashLayouts(prefix);
  expect(() => project(prefix)).toThrow(/struct footprint/);
  const status = fixture();
  Object.assign(status.response.result.layouts[status.valuesLayout], {
    runtimeSized: false,
    size: 4,
  });
  rehashLayouts(status);
  expect(() => project(status)).toThrow(/struct footprint/);
});

test("minimum binding size covers one runtime element plus enclosing padding", () => {
  const padded = fixture();
  const root = padded.response.result.layouts[padded.valuesLayout];
  root.alignment = 32;
  (root.members as RecordValue[])[0].alignment = 32;
  padded.values.minimumBindingSize = 32;
  rehashLayouts(padded);
  expect(project(padded).storage[0]).toMatchObject({
    minimumBindingSize: 32,
    alignment: 32,
  });
  padded.values.minimumBindingSize = 16;
  expect(() => project(padded)).toThrow(/minimum binding size/);
  const fixed = fixture();
  fixed.output.minimumBindingSize = 4;
  expect(() => project(fixed)).toThrow(/minimum binding size/);
});

test("unsupported storage atomics fail closed before generated host code", () => {
  const atomic = numericFixture({ kind: "atomic" }, { alignment: 4, size: 4 });
  expect(() => project(atomic)).toThrow(/unsupported storage type/);
});

test("storage graph traversal has an explicit nesting bound", () => {
  const deep = fixture();
  let typeId = deep.outputType;
  let layoutId = deep.outputLayout;
  for (let index = 0; index < 65; index++) {
    const type = { kind: "array", element: typeId, count: 1 };
    typeId = graphId("type", type);
    const layout = {
      type: typeId,
      alignment: 4,
      minimumSize: 8,
      size: 8,
      runtimeSized: false,
      arrayStride: 8,
      elementLayout: layoutId,
      members: [],
    };
    layoutId = graphId("layout", layout);
    deep.response.result.types[typeId] = type;
    deep.response.result.layouts[layoutId] = layout;
  }
  Object.assign(deep.output, { type: typeId, layout: layoutId });
  expect(() => project(deep)).toThrow(/storage graph nesting exceeds 64/);
});

test("the compute storage profile rejects sampling and active override state", () => {
  const sampling = fixture();
  (sampling.response.result.entryPoints[0].samplingPairs as RecordValue[]).push(
    { texture: "g0b0", sampler: "g0b1", mode: "filtering" }
  );
  expect(() => project(sampling)).toThrow(/sampling pairs/);
  const override = fixture();
  (override.response.result.entryPoints[0].overrides as string[]).push(
    "active_override"
  );
  expect(() => project(override)).toThrow(/active overrides/);
});

test("semantic struct member identities must be unique even when physical names agree", () => {
  const duplicate = fixture();
  const members = [
    { name: "same", type: duplicate.scalar },
    { name: "same", type: duplicate.scalar },
  ];
  const type = { kind: "struct", wgslName: "Repeated", members };
  const typeId = graphId("type", type);
  const layout = {
    type: typeId,
    alignment: 4,
    minimumSize: 8,
    size: 8,
    runtimeSized: false,
    members: members.map((member, index) => ({
      ...member,
      layout: duplicate.scalarLayout,
      offset: index * 4,
      alignment: 4,
      minimumSize: 4,
      size: 4,
      runtimeSized: false,
    })),
  };
  const layoutId = graphId("layout", layout);
  duplicate.response.result.types[typeId] = type;
  duplicate.response.result.layouts[layoutId] = layout;
  Object.assign(duplicate.output, { type: typeId, layout: layoutId });
  expect(() => project(duplicate)).toThrow(/duplicate struct member/);
});

function fixture() {
  const types: Record<string, RecordValue> = {};
  const layouts: Record<string, RecordValue> = {};
  const type = (descriptor: RecordValue) => {
    const id = graphId("type", descriptor);
    types[id] = descriptor;
    return id;
  };
  const layout = (descriptor: RecordValue) => {
    const id = graphId("layout", descriptor);
    layouts[id] = descriptor;
    return id;
  };
  const scalar = type({ kind: "scalar", scalar: "u32" });
  const scalarLayout = layout({
    type: scalar,
    alignment: 4,
    minimumSize: 4,
    size: 4,
    runtimeSized: false,
    members: [],
  });
  const particle = type({
    kind: "struct",
    wgslName: "resolved_Particle",
    members: [
      { name: "mass", type: scalar },
      { name: "id", type: scalar },
    ],
  });
  const particleLayout = layout({
    type: particle,
    alignment: 4,
    minimumSize: 12,
    size: 12,
    runtimeSized: false,
    members: [
      {
        name: "mass",
        type: scalar,
        layout: scalarLayout,
        offset: 0,
        alignment: 4,
        minimumSize: 8,
        size: 8,
        runtimeSized: false,
      },
      {
        name: "id",
        type: scalar,
        layout: scalarLayout,
        offset: 8,
        alignment: 4,
        minimumSize: 4,
        size: 4,
        runtimeSized: false,
      },
    ],
  });
  const array = type({ kind: "array", element: particle });
  const arrayLayout = layout({
    type: array,
    alignment: 4,
    minimumSize: 0,
    runtimeSized: true,
    arrayStride: 12,
    elementLayout: particleLayout,
    members: [],
  });
  const valuesType = type({
    kind: "struct",
    wgslName: "resolved_Values",
    members: [
      { name: "prefix", type: scalar },
      { name: "particles", type: array },
    ],
  });
  const valuesLayout = layout({
    type: valuesType,
    alignment: 4,
    minimumSize: 4,
    runtimeSized: true,
    members: [
      {
        name: "prefix",
        type: scalar,
        layout: scalarLayout,
        offset: 0,
        alignment: 4,
        minimumSize: 4,
        size: 4,
        runtimeSized: false,
      },
      {
        name: "particles",
        type: array,
        layout: arrayLayout,
        offset: 4,
        alignment: 4,
        minimumSize: 0,
        runtimeSized: true,
      },
    ],
  });
  const outputType = type({ kind: "array", element: scalar, count: 2 });
  const outputLayout = layout({
    type: outputType,
    alignment: 4,
    minimumSize: 8,
    size: 8,
    runtimeSized: false,
    arrayStride: 4,
    elementLayout: scalarLayout,
    members: [],
  });
  const values = {
    id: "g0b0",
    name: "values",
    group: 0,
    binding: 0,
    kind: "buffer",
    addressSpace: "storage",
    access: "read",
    type: valuesType,
    layout: valuesLayout,
    minimumBindingSize: 16,
  };
  const output = {
    id: "g0b1",
    name: "output",
    group: 0,
    binding: 1,
    kind: "buffer",
    addressSpace: "storage",
    access: "read_write",
    type: outputType,
    layout: outputLayout,
    minimumBindingSize: 8,
  };
  const domain = "vgpu-native-tint-semantic-extraction-request-bytes/v1";
  const response = {
    schemaVersion: 1,
    contractId: semanticContract,
    compiler: compilerIdentity,
    ok: true,
    diagnostics: [],
    requestIdentity: { domain, sha256: digest(`${domain}\0${requestBytes}`) },
    result: {
      entryPoints: [
        {
          stage: "compute",
          wgsl: "count_main",
          semanticInterface: {
            kind: "compute",
            inputs: [] as RecordValue[],
            outputs: [],
          },
          bindings: ["g0b0", "g0b1"],
          samplingPairs: [],
          overrides: [],
          workgroupSize: { x: 1, y: 1, z: 1 },
        },
      ],
      bindings: [output, values],
      overrides: [],
      types,
      layouts,
    },
  };
  return {
    response,
    values,
    output,
    scalar,
    scalarLayout,
    particle,
    particleLayout,
    array,
    arrayLayout,
    valuesType,
    valuesLayout,
    outputType,
    outputLayout,
  };
}

function project(input: ReturnType<typeof fixture>) {
  return projectComputeStorage(
    checkedSemanticResult(input.response, requestBytes, selected)
  );
}

function numericFixture(
  type: RecordValue,
  physical: { alignment: number; size: number; matrixStride?: number }
) {
  const input = fixture();
  const scalar = { kind: "scalar", scalar: "f32" };
  const scalarId = graphId("type", scalar);
  const descriptor = { ...type, element: scalarId };
  const typeId = graphId("type", descriptor);
  const layout = {
    type: typeId,
    ...physical,
    minimumSize: physical.size,
    runtimeSized: false,
    members: [],
  };
  const layoutId = graphId("layout", layout);
  input.response.result.types = { [scalarId]: scalar, [typeId]: descriptor };
  input.response.result.layouts = { [layoutId]: layout };
  Object.assign(input.output, {
    type: typeId,
    layout: layoutId,
    minimumBindingSize: physical.size,
  });
  input.response.result.bindings = [input.output];
  input.response.result.entryPoints[0].bindings = [input.output.id];
  return input;
}

// Fixtures insert children before parents; rehashing preserves explicit edges.
function rehashLayouts(input: ReturnType<typeof fixture>) {
  const ids = new Map<string, string>();
  const layouts: Record<string, RecordValue> = {};
  for (const [oldId, descriptor] of Object.entries(
    input.response.result.layouts
  )) {
    if (typeof descriptor.elementLayout === "string")
      descriptor.elementLayout =
        ids.get(descriptor.elementLayout) ?? descriptor.elementLayout;
    for (const member of descriptor.members as RecordValue[])
      member.layout = ids.get(member.layout as string) ?? member.layout;
    const id = graphId("layout", descriptor);
    ids.set(oldId, id);
    layouts[id] = descriptor;
  }
  input.response.result.layouts = layouts;
  for (const binding of input.response.result.bindings)
    binding.layout = ids.get(binding.layout) ?? binding.layout;
}

function graphId(kind: "type" | "layout", value: unknown): string {
  return `${kind === "type" ? "t" : "l"}_${digest(
    `vgpu-native-semantic-${kind}/v1\0${canonicalJSON(value)}`
  )}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON((value as RecordValue)[key])}`
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
