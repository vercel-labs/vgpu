import { expect, test } from "vitest";
import { createNodeAdapter } from "@vgpu/adapter-node";
import { App } from "@vgpu/core";
import { createRenderPipelineFromDescriptor, RenderPass, Uniform } from "@vgpu/render";
import { compile } from "@vgpu/wgsl";

const TINT_WGSL = `
struct Globals { tint: vec4f };
@group(0) @binding(0) var<uniform> globals: Globals;

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  var positions = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[vi], 0.0, 1.0);
}

@fragment
fn fs_main() -> @location(0) vec4f {
  return globals.tint;
}
`;

test.skipIf(process.env.VGPU_DOCKER_TEST !== "1")(
  "Uniform drives a fragment tint through a raw-descriptor pipeline on the node adapter",
  async () => {
    const { device } = await App.create({ adapter: createNodeAdapter() });
    const shader = device.createShader(compile(TINT_WGSL));

    const uniform = new Uniform(device, { size: 16, label: "globals" });
    uniform.write(new Float32Array([0, 1, 0, 1]));

    const pipeline = createRenderPipelineFromDescriptor(device, {
      label: "tint.pipeline",
      layout: device.gpu.createPipelineLayout({ bindGroupLayouts: [uniform.bindGroupLayout] }),
      vertex: { module: shader.gpu, entryPoint: "vs_main" },
      fragment: { module: shader.gpu, entryPoint: "fs_main", targets: [{ format: "rgba8unorm" }] },
      primitive: { topology: "triangle-list" },
    });

    const target = device.createTexture({ size: [16, 16], format: "rgba8unorm", usage: ["render_attachment", "copy_src"] });
    const pass = new RenderPass(device, {
      colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }],
    });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, uniform.bindGroup);
    pass.draw(3);
    pass.end();

    const pixels = await target.read();
    expect(pixels[0]).toBeLessThan(16);
    expect(pixels[1]).toBeGreaterThan(240);
    expect(pixels[2]).toBeLessThan(16);

    uniform.destroy();
    device.destroy();
  },
);
