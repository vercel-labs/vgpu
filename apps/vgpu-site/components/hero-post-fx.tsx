"use client";

import { useEffect, useRef } from "react";
import { readHeroFxState } from "./hero-fx-state";

const MAX_DOTS = 768;
const SHADER = /* wgsl */ `
const MAX_DOTS: u32 = 768u;

struct Uniforms {
  resolution: vec2f,
  dot_count: f32,
  bloom_intensity: f32,
  bloom_threshold: f32,
  rgb_shift: f32,
  particle_occupancy: f32,
  color: vec3f,
  _pad0: f32,
};

struct Dot {
  data: vec4f,
};

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var<storage, read> dots: array<Dot, MAX_DOTS>;

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

fn dot_field(pixel: vec2f, channel_offset: f32) -> f32 {
  var sum = 0.0;
  let count = min(u32(uniforms.dot_count), MAX_DOTS);
  let occupancy = clamp(uniforms.particle_occupancy, 0.55, 1.0);
  let core_radius = mix(1.55, 2.8, occupancy);
  let bloom_radius = mix(9.0, 18.0, occupancy);
  for (var i = 0u; i < MAX_DOTS; i = i + 1u) {
    if (i >= count) { break; }
    let dot = dots[i].data;
    let visible = dot.w;
    if (visible <= 0.0) { continue; }
    let center = dot.xy + vec2f(channel_offset, 0.0);
    let morph = clamp(dot.z, 0.0, 1.0);
    let d = distance(pixel, center);
    let core = exp(-(d * d) / max(core_radius * core_radius, 0.001));
    let bloom = exp(-(d * d) / max(bloom_radius * bloom_radius, 0.001));
    let energy = mix(0.62, 1.45, morph) * visible;
    let thresholded = max(core * energy - uniforms.bloom_threshold, 0.0);
    sum = sum + core * 0.035 * energy + thresholded * bloom * 0.52;
  }
  return sum;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let pixel = input.position.xy;
  let shift = uniforms.rgb_shift;
  let r = dot_field(pixel, shift) * uniforms.color.r;
  let g = dot_field(pixel, 0.0) * uniforms.color.g;
  let b = dot_field(pixel, -shift) * uniforms.color.b;
  let color = vec3f(r, g, b) * uniforms.bloom_intensity;
  let toned = vec3f(1.0) - exp(-color);
  let alpha = clamp(max(max(toned.r, toned.g), toned.b), 0.0, 0.32);
  return vec4f(toned, alpha);
}
`;

type Resources = {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly pipeline: GPURenderPipeline;
  readonly uniformBuffer: GPUBuffer;
  readonly dotBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly format: GPUTextureFormat;
};

function cssNumber(name: string, fallback: number) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cssColorToRgb(color: string) {
  const trimmed = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(trimmed)) {
    return [
      Number.parseInt(trimmed.slice(1, 3), 16) / 255,
      Number.parseInt(trimmed.slice(3, 5), 16) / 255,
      Number.parseInt(trimmed.slice(5, 7), 16) / 255,
    ] as const;
  }
  return [0.63, 0.63, 0.67] as const;
}

async function createResources(canvas: HTMLCanvasElement): Promise<Resources | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "low-power" });
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const uniformBuffer = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const dotBuffer = device.createBuffer({ size: MAX_DOTS * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const shader = device.createShaderModule({ code: SHADER });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ],
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
    entries: [
      { binding: 0, resource: { buffer: uniformBuffer } },
      { binding: 1, resource: { buffer: dotBuffer } },
    ],
  });

  return { device, context, pipeline, uniformBuffer, dotBuffer, bindGroup, format };
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
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas!.width = Math.max(1, Math.round(rect.width * dpr));
      canvas!.height = Math.max(1, Math.round(rect.height * dpr));
      if (resources) {
        resources.context.configure({ device: resources.device, format: resources.format, alphaMode: "premultiplied" });
      }
    }

    function draw() {
      if (!resources || disposed) return;
      const rect = canvas!.getBoundingClientRect();
      const dpr = canvas!.width / Math.max(rect.width, 1);
      const fxState = readHeroFxState();
      const dotData = new Float32Array(MAX_DOTS * 4);
      const count = Math.min(fxState.dots.length, MAX_DOTS);
      for (let i = 0; i < count; i++) {
        const dot = fxState.dots[i]!;
        dotData[i * 4] = (dot.x - rect.left) * dpr;
        dotData[i * 4 + 1] = (dot.y - rect.top) * dpr;
        dotData[i * 4 + 2] = dot.morph;
        dotData[i * 4 + 3] = dot.visible;
      }

      const [r, g, b] = cssColorToRgb(fxState.color);
      const bloomIntensity = cssNumber("--hero-bloom-intensity", 1.15);
      const bloomThreshold = cssNumber("--hero-bloom-threshold", 0.18);
      const rgbShift = cssNumber("--hero-rgb-shift", 2.5) * dpr;
      const occupancy = cssNumber("--hero-particle-occupancy", 0.875);
      const uniforms = new Float32Array([
        canvas!.width,
        canvas!.height,
        count,
        bloomIntensity,
        bloomThreshold,
        rgbShift,
        occupancy,
        0,
        r,
        g,
        b,
        0,
        0,
        0,
        0,
        0,
      ]);

      resources.device.queue.writeBuffer(resources.dotBuffer, 0, dotData);
      resources.device.queue.writeBuffer(resources.uniformBuffer, 0, uniforms);
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

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 z-[1] h-full w-full" aria-hidden="true" />;
}
