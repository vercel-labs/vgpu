import { expect, test } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("resolveShader reports a surviving direct function export", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { surfaceColor } from "./surface.wgsl";
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(surfaceColor(vec3f(0.0), 1.0), 1.0);
}`,
      "/surface.wgsl": `export fn surfaceColor(position: vec3f, timeSeconds: f32) -> vec3f {
  return position + vec3f(timeSeconds);
}`,
    },
  });

  expect(resolved.functionExports).toEqual([
    {
      name: "surfaceColor",
      resolvedName: expect.any(String),
      parameterNames: ["position", "timeSeconds"],
    },
  ]);
  expect(resolved.wgsl).toMatch(functionDeclaration(resolved.functionExports[0]!.resolvedName));
});

test("function exports omit declarations removed before whitespace minification", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    minify: { whitespace: true },
    modules: {
      "/main.wgsl": `import { usedColor } from "./palette.wgsl";
@fragment fn fs_main() -> @location(0) vec4f { return usedColor(); }`,
      "/palette.wgsl": `export fn usedColor() -> vec4f { return vec4f(1.0); }
export fn deadColor() -> vec4f { return vec4f(0.0); }`,
    },
  });

  expect(resolved.functionExports.map((item) => item.name)).toEqual(["usedColor"]);
  expect(resolved.wgsl).toMatch(functionDeclaration(resolved.functionExports[0]!.resolvedName));
});

test("function exports follow safe identifier minification without publishing import aliases", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    minify: true,
    modules: {
      "/main.wgsl": `import { surfaceColor as shadeSurface } from "./surface.wgsl";
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(shadeSurface(vec3f(0.0), 1.0), 1.0);
}`,
      "/surface.wgsl": `export fn surfaceColor(authoredPosition: vec3f, authoredTimeSeconds: f32) -> vec3f {
  return authoredPosition + vec3f(authoredTimeSeconds);
}`,
    },
  });

  expect(resolved.functionExports).toEqual([
    {
      name: "surfaceColor",
      resolvedName: expect.any(String),
      parameterNames: ["authoredPosition", "authoredTimeSeconds"],
    },
  ]);
  expect(resolved.functionExports.map((item) => item.name)).not.toContain("shadeSurface");
  expect(resolved.wgsl).not.toContain("surfaceColor");
  expect(resolved.wgsl).not.toContain("authoredPosition");
  expect(resolved.wgsl).toMatch(functionDeclaration(resolved.functionExports[0]!.resolvedName));
});

test("duplicate authored function export names remain distinct metadata entries", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    minify: true,
    modules: {
      "/main.wgsl": `import { sample as sampleA } from "./a.wgsl";
import { sample as sampleB } from "./b.wgsl";
@fragment fn fs_main() -> @location(0) vec4f {
  return vec4f(sampleA(1.0), sampleB(2.0), 0.0, 1.0);
}`,
      "/a.wgsl": "export fn sample(firstValue: f32) -> f32 { return firstValue; }",
      "/b.wgsl": "export fn sample(secondValue: f32) -> f32 { return secondValue; }",
    },
  });

  const duplicates = resolved.functionExports.filter((item) => item.name === "sample");
  expect(duplicates).toHaveLength(2);
  expect(new Set(duplicates.map((item) => item.resolvedName))).toHaveProperty("size", 2);
  expect(duplicates.map((item) => item.parameterNames)).toEqual([["firstValue"], ["secondValue"]]);
  for (const item of duplicates) expect(resolved.wgsl).toMatch(functionDeclaration(item.resolvedName));
});

test("an attribute before export produces one function export entry", async () => {
  const resolved = await resolveShader({
    entry: "/surface.wgsl",
    validate: false,
    modules: {
      "/surface.wgsl": "@must_use export fn surfaceValue(value: f32) -> f32 { return value; }",
    },
  });

  expect(resolved.functionExports).toEqual([
    {
      name: "surfaceValue",
      resolvedName: expect.any(String),
      parameterNames: ["value"],
    },
  ]);
  expect(resolved.wgsl).toMatch(functionDeclaration(resolved.functionExports[0]!.resolvedName));
});

test("comment trivia between export and fn preserves function export metadata", async () => {
  const cases = [
    ["/block-comment.wgsl", "export /* declaration gap */ fn surfaceValue(value: f32) -> f32 { return value; }"],
    ["/line-comment.wgsl", "export // declaration gap\nfn surfaceValue(value: f32) -> f32 { return value; }"],
  ] as const;

  for (const [entry, source] of cases) {
    const resolved = await resolveShader({
      entry,
      validate: false,
      modules: { [entry]: source },
    });

    expect(resolved.functionExports).toEqual([
      {
        name: "surfaceValue",
        resolvedName: expect.stringMatching(/^_vgsl_[0-9a-f]{8}__surfaceValue$/u),
        parameterNames: ["value"],
      },
    ]);
    expect(resolved.wgsl).not.toMatch(/\bexport\b/u);
    expect(resolved.wgsl).toMatch(functionDeclaration(resolved.functionExports[0]!.resolvedName));
  }
});

function functionDeclaration(name: string): RegExp {
  return new RegExp(`\\bfn\\s+${escapeRegExp(name)}\\s*\\(`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
