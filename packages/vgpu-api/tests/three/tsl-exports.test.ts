import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { tslExports } from "vgpu/three";

test("turns a raw WGSL function into a callable Three node", () => {
  const { doubleValue } = tslExports(
    "fn doubleValue(value: f32) -> f32 { return value * 2.0; }",
  )("doubleValue");

  expect(doubleValue({ value: 2 })).toMatchObject({ isNode: true });
});

test("rejects declarations in the adapter's private WGSL namespace", () => {
  const source = `
fn _vgpu_three_0(value: f32) -> f32 { return value; }
fn surfaceValue(value: f32) -> f32 { return _vgpu_three_0(value); }
`;

  expect(errorCode(() => tslExports(source)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SOURCE-INVALID",
  );
});

test("rejects top-level diagnostic directives from resolved modules", async () => {
  const source = await resolveShader({
    entry: "/surface.wgsl",
    validate: false,
    modules: {
      "/surface.wgsl": `
diagnostic(off, derivative_uniformity);

export fn surfaceValue(value: f32) -> f32 { return value; }
`,
    },
  });

  expect(errorCode(() => tslExports(source)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
  );
});

test("rejects top-level enable directives", () => {
  const source = `
enable f16;

fn surfaceValue(value: f32) -> f32 { return value; }
`;

  expect(errorCode(() => tslExports(source)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
  );
});

test("rejects top-level requires directives", () => {
  const source = `
requires readonly_and_readwrite_storage_textures;

fn surfaceValue(value: f32) -> f32 { return value; }
`;

  expect(errorCode(() => tslExports(source)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
  );
});

test("allows directive words in comments and supported diagnostic attributes", () => {
  const sources = [
    `
// diagnostic(off, derivative_uniformity);
// enable f16;
/* requires readonly_and_readwrite_storage_textures; */
@diagnostic(off, derivative_uniformity)
fn surfaceValue(value: f32) -> f32 { return value; }
`,
    `
fn surfaceValue(value: f32) -> f32 {
  @diagnostic(off, derivative_uniformity) {
    return value;
  }
}
`,
  ];

  const nodes = sources.map((source) => {
    const { surfaceValue } = tslExports(source)("surfaceValue");
    return surfaceValue({ value: 2 });
  });

  expect(nodes).toMatchObject([{ isNode: true }, { isNode: true }]);
});

test("finds resolver-mangled functions in legacy shader artifacts", () => {
  const legacyArtifact = {
    version: 1 as const,
    wgsl: "fn _vgsl_deadbeef__doubleValue(value: f32) -> f32 { return value * 2.0; }",
  };

  const { doubleValue } = tslExports(legacyArtifact)("doubleValue");

  expect(doubleValue({ value: 2 })).toMatchObject({ isNode: true });
});

test("treats an empty function export list as authoritative", () => {
  const artifact = {
    wgsl: "fn privateValue(value: f32) -> f32 { return value; }",
    functionExports: [],
  };

  expect(errorCode(() => tslExports(artifact)("privateValue"))).toBe(
    "VGPU-THREE-TSL-EXPORT-NOT-FOUND",
  );
});

test("rejects duplicate authored export names as ambiguous", () => {
  const artifact = {
    wgsl: `
fn firstValue(value: f32) -> f32 { return value; }
fn secondValue(value: f32) -> f32 { return value; }
`,
    functionExports: [
      { name: "surfaceValue", resolvedName: "firstValue", parameterNames: ["value"] },
      { name: "surfaceValue", resolvedName: "secondValue", parameterNames: ["value"] },
    ],
  };

  expect(errorCode(() => tslExports(artifact)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-EXPORT-AMBIGUOUS",
  );
});

test("reports malformed export metadata as an invalid source", () => {
  const artifact = {
    wgsl: "fn finalValue(value: f32) -> f32 { return value; }",
    functionExports: [{
      name: "surfaceValue",
      resolvedName: 42 as unknown as string,
      parameterNames: ["value"],
    }],
  };

  expect(errorCode(() => tslExports(artifact)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SOURCE-INVALID",
  );
});

test("reports unreadable export metadata as an invalid source", () => {
  const unreadable = Object.defineProperty(
    { resolvedName: "finalValue", parameterNames: ["value"] },
    "name",
    {
      get() {
        throw new Error("unreadable metadata");
      },
    },
  ) as {
    readonly name: string;
    readonly resolvedName: string;
    readonly parameterNames: readonly string[];
  };
  const artifact = {
    wgsl: "fn finalValue(value: f32) -> f32 { return value; }",
    functionExports: [unreadable],
  };

  expect(errorCode(() => tslExports(artifact)("surfaceValue"))).toBe(
    "VGPU-THREE-TSL-SOURCE-INVALID",
  );
});

test("rejects invalid authored and resolved identifiers in export metadata", () => {
  const invalidArtifacts = [
    {
      wgsl: "fn finalValue(value: f32) -> f32 { return value; }",
      functionExports: [{
        name: "__proto__",
        resolvedName: "finalValue",
        parameterNames: ["value"],
      }],
      requestedName: "__proto__",
    },
    {
      wgsl: "fn _(value: f32) -> f32 { return value; }",
      functionExports: [{
        name: "surfaceValue",
        resolvedName: "_",
        parameterNames: ["value"],
      }],
      requestedName: "surfaceValue",
    },
  ];

  const codes = invalidArtifacts.map((artifact) => errorCode(
    () => tslExports(artifact)(artifact.requestedName),
  ));
  expect(codes).toEqual(invalidArtifacts.map(() => "VGPU-THREE-TSL-SOURCE-INVALID"));
});

test("returns exports in a null-prototype map", () => {
  const exports = tslExports(
    "fn surfaceValue(value: f32) -> f32 { return value; }",
  )("surfaceValue");

  expect(Object.getPrototypeOf(exports)).toBeNull();
  expect(Object.hasOwn(exports, "surfaceValue")).toBe(true);
});

test("does not consume a later function body when the selected declaration has none", () => {
  const malformedSources = [
    `fn finalValue(value: f32) -> f32;
fn laterValue(value: f32) -> f32 { return value; }`,
    `fn finalValue(value: f32) -> f32
fn laterValue(value: f32) -> f32 { return value; }`,
  ];

  const codes = malformedSources.map((wgsl) => errorCode(() => tslExports({
    wgsl,
    functionExports: [{
      name: "surfaceValue",
      resolvedName: "finalValue",
      parameterNames: ["value"],
    }],
  })("surfaceValue")));

  expect(codes).toEqual(malformedSources.map(() => "VGPU-THREE-TSL-SOURCE-INVALID"));
});

test("rejects void and shader-stage functions as unsupported signatures", () => {
  const unsupported = [
    {
      wgsl: "fn logValue(value: f32) { _ = value; }",
      functionExports: [
        { name: "logValue", resolvedName: "logValue", parameterNames: ["value"] },
      ],
      name: "logValue",
    },
    {
      wgsl: "@compute @workgroup_size(1) fn simulate() {}",
      functionExports: [
        { name: "simulate", resolvedName: "simulate", parameterNames: [] },
      ],
      name: "simulate",
    },
  ];

  expect(unsupported.map((artifact) => errorCode(
    () => tslExports(artifact)(artifact.name),
  ))).toEqual([
    "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
    "VGPU-THREE-TSL-SIGNATURE-UNSUPPORTED",
  ]);
});

test("parses nested parameter types while ignoring decoy comment headers", () => {
  const artifact = {
    wgsl: `
// fn sampleField(decoy: f32) -> f32 { return decoy; }
/* fn sampleField(anotherDecoy: f32) -> f32 { return anotherDecoy; } */
fn sampleField(samples: array<vec2<f32>, 2>, scale: f32) -> f32 {
  return samples[0].x * scale;
}
`,
    functionExports: [{
      name: "sampleField",
      resolvedName: "sampleField",
      parameterNames: ["samples", "scale"],
    }],
  };

  const { sampleField } = tslExports(artifact)("sampleField");

  expect(sampleField({ samples: 0, scale: 2 })).toMatchObject({ isNode: true });
});

test("calls an identifier-minified export with its authored parameter names", async () => {
  const resolved = await resolveShader({
    entry: "/surface.wgsl",
    validate: false,
    minify: true,
    modules: {
      "/surface.wgsl": `
export fn scaleValue(authoredValue: f32, authoredScale: f32) -> f32 {
  return authoredValue * authoredScale;
}
`,
    },
  });

  expect(resolved.wgsl).not.toContain("scaleValue");
  expect(resolved.functionExports).toEqual([
    {
      name: "scaleValue",
      resolvedName: expect.any(String),
      parameterNames: ["authoredValue", "authoredScale"],
    },
  ]);

  const { scaleValue } = tslExports(resolved)("scaleValue");
  expect(scaleValue({ authoredValue: 2, authoredScale: 3 })).toMatchObject({
    isNode: true,
  });
});

function errorCode(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return (error as { readonly code?: unknown }).code;
  }
  return undefined;
}
