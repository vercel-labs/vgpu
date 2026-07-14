import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { compile } from "@vgpu/wgsl";
import { resolveShader } from "@vgpu/wgsl/runtime";

test("non-exported imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from './a.wgsl'; fn main(){x();}", "/a.wgsl": "fn x(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-SYM-NOEXPORT" }));
test("import aliases rebind use sites", async () => expect((await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x as y } from './a.wgsl'; fn main(){y();}", "/a.wgsl": "export fn x(){}" }, validate: false })).wgsl).toMatch(/fn _vgsl_[0-9a-f]{8}__main\(\)\{_vgsl_[0-9a-f]{8}__x\(\);\}/));
test("conflicting imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { a as x } from './a.wgsl'; import { b as x } from './b.wgsl';", "/a.wgsl": "export fn a(){}", "/b.wgsl": "export fn b(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-SYM-IMPORT-SHADOW" }));
test("default imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import x from './a.wgsl';", "/a.wgsl": "" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-DEFAULT" }));
test("side-effect imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import './a.wgsl';", "/a.wgsl": "" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-SIDEEFFECT" }));
test("imports after declarations error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "fn f(){} import { x } from './a.wgsl';", "/a.wgsl": "export fn x(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-ORDER" }));
test("self imports error", async () => await expect(resolveShader({ entry: "/a.wgsl", modules: { "/a.wgsl": "import { a } from './a.wgsl'; export fn a(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-SELF" }));
test("absolute imports error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from '/x.wgsl';" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-RES-ABS" }));
test("comment-only import is treated as plain WGSL", () => {
  const source = "// import { x } from './x.wgsl'\n@compute @workgroup_size(1) fn main() {}";
  expect(compile(source).wgsl).toBe(source);
});
test("simple two-file import resolves", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { color } from "./palette.wgsl";
@fragment
fn fs_main() -> @location(0) vec4f {
  return color();
}`,
      "/palette.wgsl": `export fn color() -> vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}`,
    },
  });

  expect(resolved.wgsl).toContain("fn _vgsl_");
  expect(resolved.wgsl).toContain("return _vgsl_");
  expect(resolved.wgsl).toContain("fn fs_main(");
  expect(resolved.cacheKey.fs_main).toMatch(/^vgsl-1:[0-9a-f]{32}$/);
});
test("imported entry-point names are preserved", async () => {
  const resolved = await resolveShader({
    entry: "/main.wgsl",
    validate: false,
    modules: {
      "/main.wgsl": `import { shade } from "./fragment.wgsl";
fn helper() { shade(); }`,
      "/fragment.wgsl": `export fn shade() {}
@fragment fn fs_main() -> @location(0) vec4f { return vec4f(1.0); }`,
    },
  });

  expect(resolved.wgsl).toContain("fn fs_main(");
  expect(resolved.wgsl).not.toMatch(/_vgsl_[0-9a-f]{8}__fs_main/);
});
test("namespace value error", async () => {
  await expect(resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import * as palette from "./palette.wgsl";
fn f() { let x = palette; }`,
    "/palette.wgsl": "export const color = 1;",
  } })).rejects.toMatchObject({ code: "VGPU-WGSL-NS-NOTVALUE" });
});
test("namespace assignment rejected", async () => await nsValue("let m = math;"));
test("namespace argument rejected", async () => await nsValue("foo(math);"));
test("namespace computed access rejected", async () => await nsValue("math[0];"));
test("diamond emits once", async () => {
  const resolved = await resolveShader({ entry: "/main.wgsl", validate: false, modules: {
    "/main.wgsl": `import { a } from "./a.wgsl";
import { b } from "./b.wgsl";
fn main() { a(); b(); }`,
    "/a.wgsl": `import { c } from "./c.wgsl";
export fn a() { c(); }`,
    "/b.wgsl": `import { c } from "./c.wgsl";
export fn b() { c(); }`,
    "/c.wgsl": "export fn c() {}",
  } });
  expect(resolved.wgsl.match(/vgsl-module: \/c\.wgsl/g)).toHaveLength(1);
});
test("raw import rejected", () => {
  expect(() => compile(`import { color } from "./p.wgsl";`)).toThrow(expect.objectContaining({ code: "VGPU-WGSL-RUNTIME-IMPORT" }));
});
test("duplicate reachable overrides error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { a } from './a.wgsl'; import { b } from './b.wgsl';", "/a.wgsl": "override SAMPLES=1; export fn a(){}", "/b.wgsl": "override SAMPLES=2; export fn b(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-OVERRIDE-DUP" }));
test("unreachable duplicate overrides ignored", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "override SAMPLES=1;", "/u.wgsl": "override SAMPLES=2;" }, validate: false })).resolves.toHaveProperty("wgsl"));
test("duplicate entry points error", async () => await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { a } from './a.wgsl'; @compute @workgroup_size(1) fn main(){}", "/a.wgsl": "@compute @workgroup_size(1) export fn main(){} export fn a(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-ENTRYPOINT-DUP" }));
test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("pipeline constants work on Dawn", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const shader = await resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { Out } from './buf.wgsl'; @group(0) @binding(0) var<storage, read_write> out: Out; override SAMPLES: u32 = 1u; @compute @workgroup_size(1) fn main(){ out.value = SAMPLES; }", "/buf.wgsl": "export struct Out { value: u32 }" }, validate: false });
  const gpu = device.gpu;
  const b = gpu.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  gpu.queue.writeBuffer(b, 0, new Uint32Array([0]));
  const r = gpu.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const constants: Record<string, number> = { SAMPLES: 8 };
  const p = gpu.createComputePipeline({ layout: "auto", compute: { module: gpu.createShaderModule({ code: shader.wgsl }), entryPoint: "main", constants } });
  const bg = gpu.createBindGroup({ layout: p.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: b } }] });
  const e = gpu.createCommandEncoder();
  const pass = e.beginComputePass();
  pass.setPipeline(p);
  pass.setBindGroup(0, bg);
  pass.dispatchWorkgroups(1);
  pass.end();
  e.copyBufferToBuffer(b, 0, r, 0, 4);
  gpu.queue.submit([e.finish()]);
  await gpu.queue.onSubmittedWorkDone();
  await r.mapAsync(GPUMapMode.READ);
  expect(new Uint32Array(r.getMappedRange()).slice()[0]).toBe(8);
  r.unmap();
  device.destroy();
});
test("missing package errors", async () => {
  await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": "import { x } from 'missing-pkg';" }, validate: false }))
    .rejects.toMatchObject({ code: "VGPU-WGSL-PKG-NOTFOUND" });
});
test("packageMap takes precedence", async () => expect((await resolveShader({ entry: "/m.wgsl", packageMap: { "missing-pkg": "/pkg/index.wgsl" }, modules: { "/m.wgsl": "import { x } from 'missing-pkg'; fn main(){x();}", "/pkg/index.wgsl": "export fn x(){}" }, validate: false })).wgsl).toContain("/pkg/index.wgsl"));

async function nsValue(expr: string): Promise<void> {
  await expect(resolveShader({ entry: "/m.wgsl", modules: { "/m.wgsl": `import * as math from './p.wgsl'; fn foo(){} fn main(){ ${expr} }`, "/p.wgsl": "export fn x(){}" }, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-NS-NOTVALUE" });
}
