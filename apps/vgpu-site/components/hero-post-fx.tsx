"use client";

import { useEffect, useRef } from "react";

const SHADER = /* wgsl */ `
struct Uniforms {
  resolution: vec2f,
  time: f32,
  _pad0: f32,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
};

@vertex
fn vs_main(@builtin(vertex_index) vertex_index: u32) -> VertexOut {
  var positions = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f(3.0, -1.0),
    vec2f(-1.0, 3.0),
  );
  let position = positions[vertex_index];
  var out: VertexOut;
  out.position = vec4f(position, 0.0, 1.0);
  out.uv = position * 0.5 + vec2f(0.5);
  return out;
}

fn bloom_field(uv: vec2f, offset: vec2f) -> f32 {
  let aspect = uniforms.resolution.x / max(uniforms.resolution.y, 1.0);
  let p = vec2f((uv.x + offset.x - 0.5) * aspect, uv.y + offset.y - 0.31);
  let core = exp(-dot(p / vec2f(0.235, 0.036), p / vec2f(0.235, 0.036)));
  let wide = exp(-dot(p / vec2f(0.34, 0.085), p / vec2f(0.34, 0.085)));
  return core * 0.38 + wide * 0.18;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let px = 1.0 / max(uniforms.resolution.x, 1.0);
  let shift = vec2f(px * 2.0, 0.0);
  let r = bloom_field(input.uv, shift) * 0.26;
  let g = bloom_field(input.uv, vec2f(0.0)) * 0.22;
  let b = bloom_field(input.uv, -shift) * 0.28;
  let alpha = clamp(max(max(r, g), b), 0.0, 0.16);
  return vec4f(r, g, b, alpha);
}
`;

type Resources = {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly pipeline: GPURenderPipeline;
  readonly uniformBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly format: GPUTextureFormat;
};

async function createResources(canvas: HTMLCanvasElement): Promise<Resources | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const shader = device.createShaderModule({ code: SHADER });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: { module: shader, entryPoint: "vs_main" },
    fragment: {
      module: shader,
      entryPoint: "fs_main",
      targets: [{
        format,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
        },
      }],
    },
    primitive: { topology: "triangle-list" },
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  return { device, context, pipeline, uniformBuffer, bindGroup, format };
}

export function HeroPostFx() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let resources: Resources | null = null;
    let frame = 0;
    let disposed = false;

    function resize() {
      const rect = canvas!.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.round(rect.width * dpr));
      canvas!.height = Math.max(1, Math.round(rect.height * dpr));
      if (resources) {
        resources.context.configure({ device: resources.device, format: resources.format, alphaMode: "premultiplied" });
      }
    }

    function draw(now: number) {
      if (!resources || disposed) return;
      const width = canvas!.getBoundingClientRect().width;
      const height = canvas!.getBoundingClientRect().height;
      resources.device.queue.writeBuffer(resources.uniformBuffer, 0, new Float32Array([width, height, now / 1000, 0]));
      const encoder = resources.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: resources.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(resources.pipeline);
      pass.setBindGroup(0, resources.bindGroup);
      pass.draw(3, 1);
      pass.end();
      resources.device.queue.submit([encoder.finish()]);
      frame = requestAnimationFrame(draw);
    }

    const observer = new ResizeObserver(resize);
    observer.observe(canvas);

    void createResources(canvas).then((nextResources) => {
      if (disposed || !nextResources) return;
      resources = nextResources;
      resize();
      frame = requestAnimationFrame(draw);
    });

    return () => {
      disposed = true;
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[1]" aria-hidden="true" />;
}
