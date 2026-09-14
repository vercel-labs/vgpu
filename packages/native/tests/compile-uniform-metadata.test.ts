import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import {
  checkedSemanticResult,
  compilerIdentity,
  semanticContract,
} from "../src/compiler/protocol.ts";
import { projectUniforms } from "../src/compiler/uniforms.ts";

// Synthetic wire values exercise the external metadata boundary, not Tint or Metal.
// The separate native guide test provides real compiler-to-pixel evidence.
const requestBytes = "synthetic uniform metadata request";
const selected = [
  { stage: "vertex", wgsl: "vertex_main" },
  { stage: "fragment", wgsl: "fragment_main" },
];
const authoredStructs = [{ name: "Params", mangledName: "resolved_Params" }];

test("uniform projection rejects a contextual alignment that is not a power of two", () => {
  const valid = fixture();
  expect(project(valid).uniforms[0]).toMatchObject({
    name: "params",
    typeName: "Params",
    byteCount: 16,
    alignment: 16,
    members: [{ name: "gain", type: "f32", offset: 0 }],
  });

  const invalid = fixture();
  invalid.rootLayout.members[0].alignment = 12;
  rehashRootLayout(invalid);
  expect(() => project(invalid)).toThrow(/alignment/);
});

test("uniform root alignment must cover every contextual member alignment", () => {
  const invalid = fixture();
  invalid.rootLayout.members[0].alignment = 32;
  rehashRootLayout(invalid);
  expect(() => project(invalid)).toThrow(/alignment/);
});

test("uniform metadata cannot refer to an absent type or layout record", () => {
  for (const edge of [
    "rootType",
    "rootLayout",
    "leafType",
    "leafLayout",
  ] as const) {
    const invalid = fixture();
    if (edge === "rootType")
      delete invalid.response.result.types[invalid.binding.type];
    if (edge === "rootLayout")
      delete invalid.response.result.layouts[invalid.binding.layout];
    if (edge === "leafType")
      delete invalid.response.result.types[invalid.leafTypeId];
    if (edge === "leafLayout")
      delete invalid.response.result.layouts[invalid.leafLayoutId];
    expect(() => project(invalid), edge).toThrow(
      /Unsupported uniform metadata/
    );
  }
});

test("uniform metadata authenticates type and layout contents before projection", () => {
  const changedType = fixture();
  changedType.leafType.scalar = "i32";
  expect(() => project(changedType)).toThrow(/type content identity/);

  const changedLayout = fixture();
  changedLayout.leafLayout.alignment = 8;
  expect(() => project(changedLayout)).toThrow(/layout content identity/);
});

test("uniform mappings contain exactly the selected stage resource union", () => {
  const shared = fixture();
  shared.response.result.entryPoints[0].bindings = ["g0b0"];
  expect(project(shared).uniforms[0].slots).toEqual([
    { stage: "vertex", index: 0 },
    { stage: "fragment", index: 0 },
  ]);

  const missing = fixture();
  missing.response.result.entryPoints[1].bindings = ["g0b1"];
  expect(() => project(missing)).toThrow(/missing binding/);

  const unused = fixture();
  unused.response.result.entryPoints[1].bindings = [];
  expect(() => project(unused)).toThrow(/selected stage usage/);
});

test("uniform type names require an exact unique authored resolver identity", () => {
  expect(() => project(fixture(), [])).toThrow(/unique authored name/);
  expect(() =>
    project(fixture(), [{ name: "Params", mangledName: "another_Params" }])
  ).toThrow(/unique authored name/);
  expect(() =>
    project(fixture(), [
      authoredStructs[0],
      { name: "Other", mangledName: "resolved_Params" },
    ])
  ).toThrow(/unique authored name/);
  expect(
    project(fixture(), [
      { name: "OriginalParams", mangledName: "resolved_Params" },
    ]).uniforms[0].typeName
  ).toBe("OriginalParams");
});

test("uniform projection rejects a non-power-of-two root alignment", () => {
  const invalid = fixture();
  invalid.rootLayout.alignment = 24;
  invalid.rootLayout.size =
    invalid.rootLayout.minimumSize =
    invalid.binding.minimumBindingSize =
      48;
  rehashRootLayout(invalid);
  expect(() => project(invalid)).toThrow(/alignment/);
});

test("uniform root size must include complete trailing alignment padding", () => {
  const invalid = fixture();
  invalid.rootLayout.size =
    invalid.rootLayout.minimumSize =
    invalid.binding.minimumBindingSize =
      20;
  rehashRootLayout(invalid);
  expect(() => project(invalid)).toThrow(/size/);
});

test("uniform layout size must fit the generated positive uint32 byte-count contract", () => {
  const invalid = fixture();
  invalid.rootLayout.size =
    invalid.rootLayout.minimumSize =
    invalid.binding.minimumBindingSize =
      0x1_0000_0000;
  rehashRootLayout(invalid);
  expect(() => project(invalid)).toThrow(/size/);
});

test("uniform contextual size attributes preserve padding and prevent member overlap", () => {
  const padded = fixture();
  padded.rootType.members.push({ name: "nextGain", type: padded.leafTypeId });
  padded.rootLayout.members[0].size =
    padded.rootLayout.members[0].minimumSize = 32;
  padded.rootLayout.members.push({
    ...padded.rootLayout.members[0],
    name: "nextGain",
    offset: 32,
    alignment: 4,
    size: 4,
    minimumSize: 4,
  });
  padded.rootLayout.size =
    padded.rootLayout.minimumSize =
    padded.binding.minimumBindingSize =
      48;
  rehashRootType(padded);
  expect(project(padded).uniforms[0]).toMatchObject({
    byteCount: 48,
    members: [
      { name: "gain", type: "f32", offset: 0 },
      { name: "nextGain", type: "f32", offset: 32 },
    ],
  });

  padded.rootLayout.members[1].offset = 16;
  rehashRootLayout(padded);
  expect(() => project(padded)).toThrow(/contextual member range/);
});

test("uniform contextual extents outside the root fail even at safe-integer limits", () => {
  for (const field of ["offset", "size"] as const) {
    const invalid = fixture();
    invalid.rootLayout.members[0][field] = Number.MAX_SAFE_INTEGER - 15;
    if (field === "size")
      invalid.rootLayout.members[0].minimumSize =
        invalid.rootLayout.members[0].size;
    rehashRootLayout(invalid);
    expect(() => project(invalid)).toThrow(/contextual member range/);
  }
});

test("unsupported Swift names fail during metadata validation with contextual compiler errors", () => {
  for (const target of ["binding", "type", "member"] as const) {
    const invalid = fixture();
    let names = authoredStructs;
    if (target === "binding") invalid.binding.name = "Functions";
    if (target === "type")
      names = [{ ...authoredStructs[0], name: "Functions" }];
    if (target === "member") {
      invalid.rootType.members[0].name = invalid.rootLayout.members[0].name =
        "Functions";
      rehashRootType(invalid);
    }
    expect(() => project(invalid, names), target).toThrowError(
      expect.objectContaining({
        name: "MetalCompileError",
        stage: "validation",
        cause: expect.any(TypeError),
      })
    );
  }
});

test("projected uniform bindings and members cannot have duplicate Swift names", () => {
  const duplicateBinding = fixture();
  duplicateBinding.response.result.bindings.push({
    ...duplicateBinding.binding,
    id: "g0b1",
    binding: 1,
    name: "PARAMS",
  });
  duplicateBinding.response.result.entryPoints[1].bindings.push("g0b1");
  expect(() => project(duplicateBinding)).toThrow(/duplicate.*binding name/);

  const duplicateMember = fixture();
  duplicateMember.rootType.members.push({
    name: "GAIN",
    type: duplicateMember.leafTypeId,
  });
  duplicateMember.rootLayout.members.push({
    ...duplicateMember.rootLayout.members[0],
    name: "GAIN",
    offset: 4,
    alignment: 4,
  });
  rehashRootType(duplicateMember);
  expect(() => project(duplicateMember)).toThrow(/duplicate.*member name/);
});

test("uniform projection rejects rehashed but inconsistent logical-to-physical graph joins", () => {
  const wrongRoot = fixture();
  wrongRoot.rootLayout.type = wrongRoot.leafTypeId;
  rehashRootLayout(wrongRoot);
  expect(() => project(wrongRoot)).toThrow(/matching root layout/);

  const wrongMember = fixture();
  wrongMember.rootLayout.members[0].name = "differentGain";
  rehashRootLayout(wrongMember);
  expect(() => project(wrongMember)).toThrow(/logical and physical members/);

  const wrongChild = fixture();
  wrongChild.leafLayout.type = wrongChild.binding.type;
  delete wrongChild.response.result.layouts[wrongChild.leafLayoutId];
  const changedChildId = graphId("layout", wrongChild.leafLayout);
  wrongChild.response.result.layouts[changedChildId] = wrongChild.leafLayout;
  wrongChild.rootLayout.members[0].layout = changedChildId;
  rehashRootLayout(wrongChild);
  expect(() => project(wrongChild)).toThrow(/member layout does not match/);
});

function fixture() {
  const leafType = { kind: "scalar", scalar: "f32" };
  const leafTypeId = graphId("type", leafType);
  const rootType = {
    kind: "struct",
    wgslName: "resolved_Params",
    members: [{ name: "gain", type: leafTypeId }],
  };
  const rootTypeId = graphId("type", rootType);
  const leafLayout = {
    type: leafTypeId,
    alignment: 4,
    minimumSize: 4,
    size: 4,
    runtimeSized: false,
    members: [],
  };
  const leafLayoutId = graphId("layout", leafLayout);
  // Equivalent to one @align(16) gain: f32 member, including trailing padding.
  const rootLayout = {
    type: rootTypeId,
    alignment: 16,
    minimumSize: 16,
    size: 16,
    runtimeSized: false,
    members: [
      {
        name: "gain",
        type: leafTypeId,
        layout: leafLayoutId,
        offset: 0,
        alignment: 16,
        minimumSize: 4,
        size: 4,
        runtimeSized: false,
      },
    ],
  };
  const rootLayoutId = graphId("layout", rootLayout);
  const binding = {
    id: "g0b0",
    name: "params",
    group: 0,
    binding: 0,
    kind: "buffer",
    addressSpace: "uniform",
    access: "read",
    type: rootTypeId,
    layout: rootLayoutId,
    minimumBindingSize: 16,
  };
  const requestDomain = "vgpu-native-tint-semantic-extraction-request-bytes/v1";
  const response = {
    schemaVersion: 1,
    contractId: semanticContract,
    compiler: compilerIdentity,
    ok: true,
    diagnostics: [],
    requestIdentity: {
      domain: requestDomain,
      sha256: digest(`${requestDomain}\0${requestBytes}`),
    },
    result: {
      entryPoints: selected.map(({ stage, wgsl }) => ({
        stage,
        wgsl,
        semanticInterface: {
          kind: stage,
          inputs: [],
          outputs: [
            {
              type: { scalar: "f32", width: 4 },
              invariant: false,
              ...(stage === "vertex"
                ? { builtin: "position" }
                : { location: 0 }),
            },
          ],
        },
        bindings: stage === "fragment" ? ["g0b0"] : [],
        samplingPairs: [],
        overrides: [],
      })),
      bindings: [binding],
      overrides: [],
      types: { [leafTypeId]: leafType, [rootTypeId]: rootType } as Record<
        string,
        unknown
      >,
      layouts: {
        [leafLayoutId]: leafLayout,
        [rootLayoutId]: rootLayout,
      } as Record<string, unknown>,
    },
  };
  return {
    response,
    binding,
    leafType,
    leafTypeId,
    rootType,
    leafLayout,
    leafLayoutId,
    rootLayout,
  };
}

function project(input: ReturnType<typeof fixture>, names = authoredStructs) {
  const semantics = checkedSemanticResult(
    input.response,
    requestBytes,
    selected
  );
  return projectUniforms(semantics, names);
}

function rehashRootLayout(input: ReturnType<typeof fixture>): void {
  delete input.response.result.layouts[input.binding.layout];
  input.binding.layout = graphId("layout", input.rootLayout);
  input.response.result.layouts[input.binding.layout] = input.rootLayout;
}

function rehashRootType(input: ReturnType<typeof fixture>): void {
  delete input.response.result.types[input.binding.type];
  input.binding.type = graphId("type", input.rootType);
  input.response.result.types[input.binding.type] = input.rootType;
  input.rootLayout.type = input.binding.type;
  rehashRootLayout(input);
}

function graphId(kind: "type" | "layout", descriptor: unknown): string {
  const prefix = kind === "type" ? "t" : "l";
  return `${prefix}_${digest(
    `vgpu-native-semantic-${kind}/v1\0${canonicalJSON(descriptor)}`
  )}`;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJSON(
            (value as Record<string, unknown>)[key]
          )}`
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
