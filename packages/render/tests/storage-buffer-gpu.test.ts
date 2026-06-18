import { describe, expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipelineFromDescriptor, RenderPass, StorageBuffer } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

// Reads index 1 of a var<storage, read> array<f32> and emits it on the green channel.
const STORAGE_WGSL = `
@group(0) @binding(0) var<storage, read> values: array<f32>;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vi], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return vec4f(values[0], values[1], values[2], 1.0);
}
`;

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("StorageBuffer GPU integration", () => {
  test("a var<storage, read> array drives a fragment color through a raw-descriptor pipeline", async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const shader = device.createShader(compile(STORAGE_WGSL));

    const storage = new StorageBuffer(device, { size: 16, label: "values" });
    storage.write(new Float32Array([0, 1, 0, 0]));

    const pipeline = createRenderPipelineFromDescriptor(device, {
      label: "storage.pipeline",
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [storage.bindGroupLayout] }),
      vertex: { module: shader.gpu, entryPoint: "vs_main" },
      fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });

    const target = device.createTexture({ size: [16, 16], format: "rgba8unorm", usage: ["render_attachment", "copy_src"] });
    const pass = new RenderPass(device, {
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, storage.bindGroup);
    pass.draw(3);
    pass.end();

    const pixels = await target.read();
    expect(pixels[0]).toBeLessThan(16);
    expect(pixels[1]).toBeGreaterThan(240);
    expect(pixels[2]).toBeLessThan(16);

    storage.destroy();
    device.destroy();
  });
});
