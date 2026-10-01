import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface PackedBundlerFixture {
  readonly root: string;
  readonly entry: string;
  readonly transitive: string;
  readonly output: string;
  dispose(): Promise<void>;
}

export async function createPackedBundlerFixture(): Promise<PackedBundlerFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "vgpu-packed-bundler-")));
  const source = join(root, "src");
  const output = join(root, "dist");
  const transitive = join(source, "shared.wgsl");
  await Promise.all([
    mkdir(source, { recursive: true }),
    mkdir(output, { recursive: true }),
  ]);
  await writeFile(join(root, "package.json"), `${JSON.stringify({ name: "vgpu-packed-acceptance", private: true, type: "module" }, null, 2)}\n`);
  await writeFile(transitive, `
export struct SharedHelper { value: vec4f }
export fn shared_color() -> vec4f { return vec4f(0.125, 0.25, 0.5, 1.0); }
`);
  await writeFile(join(source, "shader-a.wgsl"), eagerShader("A", true));
  await writeFile(join(source, "shader-b.wgsl"), eagerShader("B", false));
  await writeFile(join(source, "shader-c.wgsl"), coldShader());
  await writeFile(join(source, "shader-d.wgsl"), deadShader());
  await writeFile(join(source, "cap-fallback.wgsl"), capFallbackShader());
  await writeFile(join(source, "cold.mjs"), `
import shader from "./shader-c.wgsl";
export default shader;
`);
  await writeFile(join(source, "unused.mjs"), `
import shader from "./shader-d.wgsl";
export const unusedShader = shader;
`);
  const entry = join(source, "entry.mjs");
  await writeFile(entry, `
import shaderA from "./shader-a.wgsl";
import shaderB from "./shader-b.wgsl";
import { unusedShader } from "./unused.mjs";

export const eager = [shaderA, shaderB];
export async function loadCold() {
  return (await import("./cold.mjs")).default;
}
`);

  return {
    root,
    entry,
    transitive,
    output,
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function eagerShader(marker: "A" | "B", withImport: boolean): string {
  return `${withImport ? 'import { SharedHelper, shared_color } from "./shared.wgsl";\n' : ""}
${layoutStruct("Params")}
${fourBindings("Params", "params")}
@group(1) @binding(0) var<storage, read> unique${marker}: array<vec4f>;
${withImport ? "@group(2) @binding(0) var<uniform> helperParams: SharedHelper;" : ""}
@compute @workgroup_size(1) fn main_${marker}() {
  let local = params0.m0;
  ${withImport ? "let color = shared_color();" : "let color = uniqueB[0];"}
  ${withImport ? "let helperValue = helperParams.value;" : ""}
  _ = local;
  _ = color;
  ${withImport ? "_ = helperValue;" : ""}
}
`;
}

function coldShader(): string {
  return `
${layoutStruct("ColdOnlyRecord")}
${fourBindings("ColdOnlyRecord", "cold")}
@compute @workgroup_size(2) fn cold_main() { _ = cold0.m0; }
`;
}

function deadShader(): string {
  return `
${layoutStruct("DeadOnlyMarker")}
${fourBindings("DeadOnlyMarker", "dead")}
@compute @workgroup_size(3) fn dead_main() { _ = dead0.m0; }
`;
}

function capFallbackShader(): string {
  const members = Array.from({ length: 21 }, (_, index) =>
    `  overCapDistinctMember${index}: f32,`
  ).join("\n");
  return `
struct QueryCapRecord {
${members}
}
${layoutStruct("QuerySharedControl", "sharedControl")}
${fourBindings("QueryCapRecord", "cap", 0)}
${fourBindings("QuerySharedControl", "control", 1)}
@compute @workgroup_size(4) fn cap_main() {
  _ = cap0.overCapDistinctMember0;
  _ = control0.sharedControl0;
}
`;
}

function layoutStruct(name: string, memberPrefix = "m"): string {
  const members = Array.from({ length: 8 }, (_, index) => {
    const type = index % 3 === 0 ? "mat4x4f" : index % 3 === 1 ? "array<vec4f, 4>" : "vec4f";
    return `  ${memberPrefix}${index}: ${type},`;
  }).join("\n");
  return `struct ${name} {\n${members}\n}`;
}

function fourBindings(type: string, prefix: string, group = 0): string {
  return Array.from({ length: 4 }, (_, index) =>
    `@group(${group}) @binding(${index}) var<uniform> ${prefix}${index}: ${type};`
  ).join("\n");
}
