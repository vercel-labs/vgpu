import { describe, expect, test } from "vitest";
import { init } from "vgpu/node";

describe.skipIf(process.env.VGPU_DOCKER_TEST !== "1")("adapter-node Docker GPU", () => {
  test("writes f32 buffer and reads it back byte-equal", async () => {
    const { device } = await init();
    const data = new Float32Array([1, 2, 3, 4]);
    const buffer = device.createBuffer({ size: data.byteLength, usage: ["copy_dst", "copy_src", "storage"] });

    buffer.write(data);
    const readback = new Float32Array(await buffer.read(data.byteLength));

    expect(readback).toEqual(data);
    buffer.destroy();
    device.destroy();
  });

  test("renders and reads back a 64x64 gradient", async () => {
    const { device } = await init();
    const gpu = device.gpu;
    const width = 64;
    const texture = gpu.createTexture({ size: [width, width], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const shader = gpu.createShaderModule({ code: `
      @vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
        let p = array(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
        return vec4f(p[i], 0, 1);
      }
      @fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
        return vec4f(p.x / 64.0, p.y / 64.0, 0.25, 1.0);
      }
    ` });
    const pipeline = gpu.createRenderPipeline({ layout: "auto", vertex: { module: shader }, fragment: { module: shader, targets: [{ format: "rgba8unorm" }] }, primitive: { topology: "triangle-list" } });
    const readback = gpu.createBuffer({ size: width * width * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: texture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 1] }] });
    pass.setPipeline(pipeline);
    pass.draw(3);
    pass.end();
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow: width * 4 }, [width, width]);
    gpu.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixels = new Uint8Array(readback.getMappedRange());
    expect([...pixels.slice(0, 4)]).toEqual([2, 2, 64, 255]);
    expect([...pixels.slice(-4)]).toEqual([253, 253, 64, 255]);
    readback.unmap();
    readback.destroy();
    texture.destroy();
    device.destroy();
  });

  test("node error scope captures validation error from invalid buffer creation", async () => {
    const { device } = await init();
    device.pushErrorScope("validation");
    device.createBuffer({ size: 16, usage: [] });

    await expect(device.popErrorScope()).resolves.toMatchObject({ name: "ValidationError", code: "VGPU-CORE-INVALID-USAGE" });
    device.destroy();
  });

  test("node device destroy is idempotent", async () => {
    const { device } = await init();

    device.destroy();
    device.destroy();

    expect(device.gpu).toBeDefined();
  });

  test("node .gpu escape hatch returns underlying GPUDevice", async () => {
    const { device } = await init();

    expect(device.gpu).toBeDefined();
    expect(typeof device.gpu.createBuffer).toBe("function");
    device.destroy();
  });
});
