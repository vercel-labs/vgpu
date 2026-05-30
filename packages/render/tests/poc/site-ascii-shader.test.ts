import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";

const WIDTH = 512;
const HEIGHT = 256;
const FORMAT: GPUTextureFormat = "rgba8unorm";
const SNAPSHOT_DIR = "packages/render/tests/poc/__snapshots__";

const shader = /* wgsl */ `
struct VertexOut {
  @builtin(position) position: vec4f,
};

@vertex
fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0),
  );
  var out: VertexOut;
  out.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  return out;
}

fn rect(pixel: vec2f, origin: vec2f, size: vec2f) -> bool {
  return pixel.x >= origin.x && pixel.x < origin.x + size.x && pixel.y >= origin.y && pixel.y < origin.y + size.y;
}

fn bit(letter: u32, col: u32, row: u32) -> bool {
  // Original fixed 7x7 coordinate maps used by the VGPU site hero.
  // letter: 0=v, 1=g, 2=p, 3=u.
  if (letter == 0u) {
    return (col == 0u && (row == 0u || row == 1u)) ||
      (col == 6u && (row == 0u || row == 1u)) ||
      (col == 1u && (row == 2u || row == 3u)) ||
      (col == 5u && (row == 2u || row == 3u)) ||
      (col == 2u && (row == 4u || row == 5u)) ||
      (col == 4u && (row == 4u || row == 5u)) ||
      (col == 3u && row == 6u);
  }
  if (letter == 1u) {
    return (row == 0u && col >= 1u && col <= 4u) ||
      (col == 0u && row >= 1u && row <= 4u) ||
      (col == 5u && (row == 1u || row == 3u || row == 4u || row == 5u || row == 6u)) ||
      (row == 3u && col >= 3u && col <= 5u) ||
      (row == 5u && col >= 1u && col <= 3u) ||
      (row == 6u && col == 4u);
  }
  if (letter == 2u) {
    return (row == 0u && col >= 0u && col <= 3u) ||
      (col == 0u) ||
      (col == 4u && (row == 1u || row == 2u)) ||
      (row == 3u && col >= 1u && col <= 3u);
  }
  return (col == 0u && row <= 5u) ||
    (col == 5u && row <= 5u) ||
    (row == 6u && col >= 1u && col <= 4u);
}

fn letterId(index: u32) -> u32 {
  if (index == 0u) { return 0u; }
  if (index == 1u) { return 1u; }
  if (index == 2u) { return 2u; }
  return 3u;
}

@fragment
fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let pixel = fragCoord.xy;
  var color = vec3f(0.019, 0.019, 0.019);

  let gridX = abs(fract(pixel.x / 32.0) - 0.5);
  let gridY = abs(fract(pixel.y / 32.0) - 0.5);
  if (gridX > 0.485 || gridY > 0.485) {
    color = color + vec3f(0.018);
  }

  let glowCenter = vec2f(256.0, 78.0);
  let glow = 1.0 - clamp(distance(pixel, glowCenter) / 230.0, 0.0, 1.0);
  color = color + vec3f(0.08) * glow * glow;

  let origin = vec2f(94.0, 34.0);
  let cell = 12.0;
  let gap = 4.0;
  let letterAdvance = 7.0 * cell + 26.0;

  for (var letterIndex = 0u; letterIndex < 4u; letterIndex = letterIndex + 1u) {
    let letterOrigin = origin + vec2f(f32(letterIndex) * letterAdvance, 0.0);
    for (var row = 0u; row < 7u; row = row + 1u) {
      for (var col = 0u; col < 7u; col = col + 1u) {
        if (bit(letterId(letterIndex), col, row)) {
          let dotOrigin = letterOrigin + vec2f(f32(col) * cell, f32(row) * cell);
          if (rect(pixel, dotOrigin, vec2f(cell - gap, cell - gap))) {
            color = vec3f(0.92, 0.92, 0.9);
          }
        }
      }
    }
  }

  if (rect(pixel, vec2f(52.0, 184.0), vec2f(116.0, 10.0)) ||
      rect(pixel, vec2f(344.0, 184.0), vec2f(116.0, 10.0))) {
    color = vec3f(0.74, 0.74, 0.72);
  }
  if (rect(pixel, vec2f(236.0, 178.0), vec2f(8.0, 8.0)) ||
      rect(pixel, vec2f(250.0, 178.0), vec2f(8.0, 8.0)) ||
      rect(pixel, vec2f(264.0, 178.0), vec2f(8.0, 8.0)) ||
      rect(pixel, vec2f(278.0, 178.0), vec2f(8.0, 8.0))) {
    color = vec3f(0.92, 0.92, 0.9);
  }

  return vec4f(color, 1.0);
}
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("VGPU site hero and footer pixel shader validates", async () => {
  const { device } = await App.create({ adapter: createNodeAdapter(), label: "site.ascii.device" });
  const target = device.createTexture({
    label: "site.ascii.target",
    size: [WIDTH, HEIGHT],
    format: FORMAT,
    usage: ["render_attachment", "copy_src"],
  });

  try {
    const module = device.gpu.createShaderModule({ label: "site.ascii.shader", code: shader });
    const pipeline = device.gpu.createRenderPipeline({
      label: "site.ascii.pipeline",
      layout: "auto",
      vertex: { module, entryPoint: "vs" },
      fragment: { module, entryPoint: "fs", targets: [{ format: FORMAT }] },
      primitive: { topology: "triangle-list" },
    });
    const encoder = device.gpu.createCommandEncoder({ label: "site.ascii.frame" });
    const pass = encoder.beginRenderPass({
      label: "site.ascii.pass",
      colorAttachments: [{
        view: target.createView(),
        loadOp: "clear",
        storeOp: "store",
        clearValue: { r: 0.02, g: 0.02, b: 0.02, a: 1 },
      }],
    });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    device.gpu.queue.submit([encoder.finish()]);
    await device.queue.flush();

    const pixels = await target.read();
    await expect(pixels).toMatchImageSnapshot({
      testName: "site-ascii-shader",
      width: WIDTH,
      height: HEIGHT,
      threshold: 0,
      snapshotDir: SNAPSHOT_DIR,
    });
  } finally {
    target.destroy();
    device.destroy();
  }
});
