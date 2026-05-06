import { createRequire } from "node:module";
import { expect, test } from "vitest";
import { createMockAdapter } from "@vgpu/adapter-mock";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipeline, RenderPass } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

const require = createRequire(import.meta.url);

const TRIANGLE_WGSL = `
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
  return vec4f(in.color, 1.0);
}
`;

test("s2 › createShader(rawString) accepts plain WGSL without resolver", async () => {
  const adapter = createMockAdapter();
  const { device } = await App.create({ adapter });
  const shader = device.createShader(TRIANGLE_WGSL);
  expect(shader).toMatchObject({ kind: "wgsl" });
  expect(() => require.resolve("@vgpu/wgsl/runtime")).toThrow();
  device.destroy();
});

test("s2 › creates render pipeline from plain WGSL on mock adapter", async () => {
  const { device } = await App.create({ adapter: createMockAdapter() });
  const shader = device.createShader(TRIANGLE_WGSL);

  const pipeline = createRenderPipeline(device, {
    shader,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });

  expect(pipeline.gpu).toBeDefined();
  device.destroy();
});

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("s2 › renders hello triangle from plain WGSL to snapshot", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter() });
  const target = device.createTexture({
    size: [256, 256],
    format: "rgba8unorm",
    usage: ["render_attachment", "copy_src"],
  });
  const shader = device.createShader(compile(TRIANGLE_WGSL));
  const pipeline = createRenderPipeline(device, {
    shader,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: "rgba8unorm" }] },
    primitive: { topology: "triangle-list" },
  });
  const pass = new RenderPass(device, {
    colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
  });

  pass.setPipeline(pipeline);
  pass.draw(3);
  pass.end();

  const pixels = await target.read();
  expect(maxRedInTopRegion(pixels)).toBeGreaterThan(200);
  // Snapshot asserts the hello-triangle is rendered byte-equal to the committed PNG.
  // Threshold 0.001 (0.1% pixel diff) per S2 acceptance criteria (issue #21 line 30).
  // Dawn's OpenGL software backend on node:22-trixie-slim is deterministic across runs.
  await expect(pixels).toMatchImageSnapshot({ testName: "hello-triangle", width: 256, height: 256, threshold: 0.001 });
  device.destroy();
});

function maxRedInTopRegion(pixels: Uint8Array): number {
  let max = 0;
  for (let y = 40; y < 100; y++) {
    for (let x = 96; x < 160; x++) max = Math.max(max, pixels[(y * 256 + x) * 4]!);
  }
  return max;
}
