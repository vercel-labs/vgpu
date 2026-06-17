import { describe, expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App, type Device, type Texture } from "@vgpu/core";
import { beginFrame, createRenderPipeline } from "@vgpu/render";
import { gpuFrameTime, pixelDiff } from "@vgpu/render/perf";

const W = 64;
const H = 64;
const FORMAT: GPUTextureFormat = "rgba8unorm";
const onGpu = process.env.VGPU_DOCKER_TEST === "1";

// pixelDiff over plain arrays needs no GPU — always runs.
describe("pixelDiff", () => {
  test("identical inputs report no difference", async () => {
    const got = await pixelDiff(
      new Uint8Array([1, 2, 3, 255]),
      new Uint8Array([1, 2, 3, 255]),
    );
    expect(got.maxByte).toBe(0);
    expect(got.changedBytes).toBe(0);
    expect(got.changedFraction).toBe(0);
  });

  test("reports max + count of differing bytes", async () => {
    const got = await pixelDiff(
      new Uint8Array([10, 10, 10, 10]),
      new Uint8Array([10, 12, 10, 255]),
    );
    expect(got.maxByte).toBe(245);
    expect(got.changedBytes).toBe(2);
    expect(got.totalBytes).toBe(4);
  });

  test("a length mismatch surfaces as a maximal difference", async () => {
    const got = await pixelDiff(new Uint8Array([1, 2]), new Uint8Array([1, 2, 3, 4]));
    expect(got.maxByte).toBe(255);
  });
});

describe.skipIf(!onGpu)("perf (GPU)", () => {
  test("gpuFrameTime returns positive per-frame stats for a real pass", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const target = renderTarget(device, "perf-frame-time");
    const pipeline = fullscreenPipeline(device, [0.2, 0.4, 0.8]);

    const result = await gpuFrameTime(
      device,
      (frame) => {
        frame.renderPass(
          {
            colorAttachments: [
              { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
            ],
          },
          (pass) => {
            pass.setPipeline(pipeline);
            pass.draw(3);
          },
        );
      },
      { frames: 16, warmup: 4 },
    );

    expect(result.samples).toBeGreaterThan(0);
    expect(Number.isFinite(result.medianMs)).toBe(true);
    expect(result.medianMs).toBeGreaterThanOrEqual(0);
    expect(["timestamp-query", "wall-clock"]).toContain(result.method);
    target.destroy();
    device.destroy();
  });

  test("pixelDiff over textures: same render is bit-exact, different render differs", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const a = await renderColor(device, [0.2, 0.4, 0.8]);
    const a2 = await renderColor(device, [0.2, 0.4, 0.8]);
    const b = await renderColor(device, [0.9, 0.1, 0.1]);

    expect((await pixelDiff(a, a2)).maxByte).toBe(0);
    expect((await pixelDiff(a, b)).maxByte).toBeGreaterThan(0);

    a.destroy();
    a2.destroy();
    b.destroy();
    device.destroy();
  });
});

function renderTarget(device: Device, label: string): Texture {
  return device.createTexture({
    size: [W, H],
    format: FORMAT,
    usage: ["render_attachment", "copy_src"],
    label,
  });
}

function fullscreenPipeline(
  device: Device,
  [r, g, b]: readonly [number, number, number],
): GPURenderPipeline {
  const shader = device.createShader(`
    @vertex fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
      var p = array<vec2f, 3>(vec2f(-1., -3.), vec2f(-1., 1.), vec2f(3., 1.));
      return vec4f(p[vi], 0., 1.);
    }
    @fragment fn fs_main() -> @location(0) vec4f { return vec4f(${r}, ${g}, ${b}, 1.); }
  `);
  return createRenderPipeline(device, {
    shader,
    vertex: { entry: "vs_main" },
    fragment: { entry: "fs_main", targets: [{ format: FORMAT }] },
    primitive: { topology: "triangle-list" },
  });
}

async function renderColor(
  device: Device,
  color: readonly [number, number, number],
): Promise<Texture> {
  const target = renderTarget(device, "perf-diff");
  const pipeline = fullscreenPipeline(device, color);
  const frame = beginFrame(device);
  frame.renderPass(
    {
      colorAttachments: [
        { view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] },
      ],
    },
    (pass) => {
      pass.setPipeline(pipeline);
      pass.draw(3);
    },
  );
  frame.submit();
  await device.queue.flush();
  return target;
}
