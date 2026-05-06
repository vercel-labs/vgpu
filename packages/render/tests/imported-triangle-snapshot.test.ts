import { readFile } from "node:fs/promises";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { resolveShader } from "@vgpu/wgsl/runtime";

const MODULES = {
  "/triangle.wgsl": `import { color } from './palette.wgsl';
struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec3f,
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2f, 3>(
    vec2f(0.0,  0.5),
    vec2f(-0.5, -0.5),
    vec2f(0.5, -0.5)
  );
  var colors = array<vec3f, 3>(
    vec3f(1.0, 0.0, 0.0),
    vec3f(0.0, 1.0, 0.0),
    vec3f(0.0, 0.0, 1.0)
  );
  var out: VSOut;
  out.pos = vec4f(positions[vi], 0.0, 1.0);
  out.color = colors[vi];
  return out;
}

@fragment
fn fs_main(in: VSOut) -> @location(0) vec4f {
  return color(in.color);
}
`,
  "/palette.wgsl": `export fn color(input: vec3f) -> vec4f {
  return vec4f(input, 1.0);
}
`,
};

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("renders imported triangle byte-equal to plain-WGSL snapshot", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const target = device.createTexture({ size: [256, 256], format: "rgba8unorm", usage: ["render_attachment", "copy_src"] });
  const resolved = await resolveShader({ entry: "/triangle.wgsl", modules: MODULES, validate: false });
  const pipeline = createRenderPipeline(device, {
    shader: device.createShader(resolved.wgsl),
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  const pass = new RenderPass(device, { colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();

  const pixels = await target.read();
  const expected = PNG.sync.read(await readFile(join(process.cwd(), "packages/render/tests/__snapshots__/hello-triangle.png")));
  const actual = new PNG({ width: 256, height: 256 });
  actual.data.set(pixels);
  const mismatched = pixelmatch(actual.data, expected.data, null, 256, 256, { threshold: 0.001 });
  expect(mismatched).toBe(0);
  device.destroy();
});
