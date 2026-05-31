"use client";

import { useEffect, useMemo, useRef } from "react";
import type { DotMapResult } from "@/lib/get-dot-map";

const WORD = "vgpu";
const CELL_PITCH = 38;

type Particle = {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly alpha: number;
  readonly delay: number;
  readonly isNoise: boolean;
  readonly morph: number;
};

type GpuResources = {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly pipeline: GPURenderPipeline;
  readonly quadBuffer: GPUBuffer;
  readonly uniformBuffer: GPUBuffer;
  readonly instanceBuffer: GPUBuffer;
  readonly bindGroup: GPUBindGroup;
  readonly format: GPUTextureFormat;
};

const SHADER = /* wgsl */ `
struct Uniforms {
  width: f32,
  height: f32,
  _pad0: f32,
  _pad1: f32,
};

struct VertexIn {
  @location(0) quad: vec2f,
  @location(1) center: vec2f,
  @location(2) size: f32,
  @location(3) opacity: f32,
  @location(4) morph: f32,
};

struct VertexOut {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) @interpolate(flat) opacity: f32,
  @location(2) @interpolate(flat) morph: f32,
};

@group(0) @binding(0) var<uniform> u: Uniforms;

@vertex
fn vs_main(input: VertexIn) -> VertexOut {
  let pixel = input.center + input.quad * input.size;
  var out: VertexOut;
  out.position = vec4f((pixel.x / u.width) * 2.0 - 1.0, 1.0 - (pixel.y / u.height) * 2.0, 0.0, 1.0);
  out.uv = input.quad;
  out.opacity = input.opacity;
  out.morph = input.morph;
  return out;
}

@fragment
fn fs_main(input: VertexOut) -> @location(0) vec4f {
  let p = input.uv;
  let m = input.morph;
  var d: f32;
  if (m < 0.28) {
    d = max(abs(p.x), abs(p.y)) - 0.68;
  } else if (m < 0.56) {
    d = length(p) - 0.68;
  } else if (m < 0.78) {
    d = max(abs(p.x) - 0.72, abs(p.y) - 0.22);
  } else {
    let q = vec2f(abs(p.x), p.y + 0.18);
    d = max(q.x * 0.8660254 + q.y * 0.5, -q.y) - 0.5;
  }
  let alpha = smoothstep(0.16, -0.16, d) * input.opacity;
  if (alpha < 0.01) { discard; }
  let tone = 0.72 + smoothstep(0.55, 1.0, input.opacity) * 0.28;
  return vec4f(vec3f(tone), alpha);
}
`;

const QUAD = new Float32Array([
  -1, -1,
  1, -1,
  -1, 1,
  -1, 1,
  1, -1,
  1, 1,
]);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - clamp(value, 0, 1), 3);
}

function deterministicNoise(index: number, salt: number) {
  const value = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function buildParticlesFromGlyphs(dotMapResult: DotMapResult, measureWidth: number, measureHeight: number): Particle[] {
  const { dotMap, ascent, descent } = dotMapResult;
  const glyphs = WORD.split(" ").join("").split("").map((char) => dotMap[char]).filter(Boolean);
  const advance = glyphs.reduce((sum, glyph) => sum + glyph.advance, 0);
  const pxPerUnit = measureWidth / Math.max(advance, 1);
  const fontHeight = (ascent - descent) * pxPerUnit;
  const topPad = (measureHeight - fontHeight) / 2;
  const real: Particle[] = [];
  let penX = 0;

  for (const char of WORD) {
    const glyph = dotMap[char];
    if (!glyph) continue;
    for (const [col, row] of glyph.dots) {
      const x = penX + (col * CELL_PITCH + CELL_PITCH / 2) * pxPerUnit;
      const y = topPad + (ascent - (row * CELL_PITCH + CELL_PITCH / 2)) * pxPerUnit;
      const centerDistance = Math.hypot(x - measureWidth / 2, y - measureHeight / 2);
      real.push({
        x,
        y,
        size: 8.5 * pxPerUnit,
        alpha: 1,
        delay: centerDistance / Math.max(measureWidth, measureHeight),
        isNoise: false,
        morph: 0.08,
      });
    }
    penX += glyph.advance * pxPerUnit;
  }

  const cellSize = CELL_PITCH * pxPerUnit;
  const realKeys = new Set(real.map((dot) => `${Math.round(dot.x / cellSize)},${Math.round(dot.y / cellSize)}`));
  const particles = [...real];
  const noiseTarget = Math.floor(real.length * 1.25);
  for (let index = 0; index < noiseTarget; index++) {
    const source = real[index % real.length];
    if (!source) continue;
    const angle = deterministicNoise(index, 1) * Math.PI * 2;
    const radius = cellSize * (1.1 + deterministicNoise(index, 2) * 3.6);
    const x = source.x + Math.cos(angle) * radius;
    const y = source.y + Math.sin(angle) * radius;
    const key = `${Math.round(x / cellSize)},${Math.round(y / cellSize)}`;
    if (realKeys.has(key)) continue;
    particles.push({
      x,
      y,
      size: (5 + deterministicNoise(index, 3) * 7) * pxPerUnit,
      alpha: 0.16 + deterministicNoise(index, 4) * 0.26,
      delay: deterministicNoise(index, 5) * 0.8,
      isNoise: true,
      morph: 0.34 + deterministicNoise(index, 6) * 0.62,
    });
  }

  return particles;
}

async function createGpuResources(canvas: HTMLCanvasElement, capacity: number): Promise<GpuResources | null> {
  if (!("gpu" in navigator)) return null;
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) return null;
  const device = await adapter.requestDevice();
  const context = canvas.getContext("webgpu");
  if (!context) return null;
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: "premultiplied" });

  const quadBuffer = device.createBuffer({ size: QUAD.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(quadBuffer, 0, QUAD);
  const uniformBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const instanceBuffer = device.createBuffer({
    size: capacity * 5 * Float32Array.BYTES_PER_ELEMENT,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
  });
  const shader = device.createShaderModule({ code: SHADER });
  const bindGroupLayout = device.createBindGroupLayout({
    entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
  });
  const pipeline = device.createRenderPipeline({
    layout: device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
    vertex: {
      module: shader,
      entryPoint: "vs_main",
      buffers: [
        { arrayStride: 8, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x2" }] },
        {
          arrayStride: 20,
          stepMode: "instance",
          attributes: [
            { shaderLocation: 1, offset: 0, format: "float32x2" },
            { shaderLocation: 2, offset: 8, format: "float32" },
            { shaderLocation: 3, offset: 12, format: "float32" },
            { shaderLocation: 4, offset: 16, format: "float32" },
          ],
        },
      ],
    },
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
  return { device, context, pipeline, quadBuffer, uniformBuffer, instanceBuffer, bindGroup, format };
}

export function VgpuPixelHero({ dotMap }: { readonly dotMap: DotMapResult }) {
  const gpuCanvasRef = useRef<HTMLCanvasElement>(null);
  const fallbackCanvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });
  const startRef = useRef(0);
  const gpuRef = useRef<GpuResources | null>(null);
  const particlesRef = useRef<Particle[]>([]);

  const maximumParticles = useMemo(() => 768, []);

  useEffect(() => {
    startRef.current = performance.now();
  }, []);

  useEffect(() => {
    const gpuCanvasElement = gpuCanvasRef.current;
    const fallbackCanvasElement = fallbackCanvasRef.current;
    const shellElement = shellRef.current;
    const measureElement = measureRef.current;
    if (!gpuCanvasElement || !fallbackCanvasElement || !shellElement || !measureElement) return;
    const gpuCanvas: HTMLCanvasElement = gpuCanvasElement;
    const fallbackCanvas: HTMLCanvasElement = fallbackCanvasElement;
    const shell: HTMLDivElement = shellElement;
    const measure: HTMLDivElement = measureElement;

    let animationFrame = 0;
    let disposed = false;
    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let reducedMotion = motionQuery.matches;
    const context2d = fallbackCanvas.getContext("2d", { alpha: true });

    const resize = () => {
      const rect = shell.getBoundingClientRect();
      const measureRect = measure.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      for (const canvas of [gpuCanvas, fallbackCanvas]) {
        canvas.width = Math.max(1, Math.round(rect.width * dpr));
        canvas.height = Math.max(1, Math.round(rect.height * dpr));
        canvas.style.width = `${rect.width}px`;
        canvas.style.height = `${rect.height}px`;
      }
      context2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
      const gpu = gpuRef.current;
      if (gpu) gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "premultiplied" });
      particlesRef.current = buildParticlesFromGlyphs(dotMap, measureRect.width, measureRect.height).slice(0, maximumParticles);
      if (reducedMotion) render(performance.now());
    };

    function frameData(now: number) {
      const shellRect = shell.getBoundingClientRect();
      const measureRect = measure.getBoundingClientRect();
      if (particlesRef.current.length === 0) {
        particlesRef.current = buildParticlesFromGlyphs(dotMap, measureRect.width, measureRect.height).slice(0, maximumParticles);
      }
      const particles = particlesRef.current;
      const elapsed = reducedMotion ? 2 : (now - startRef.current) / 1000;
      const reveal = reducedMotion ? 1 : easeOutCubic(elapsed / 0.72);
      const burst = reducedMotion ? 0 : Math.max(0, Math.sin(elapsed * 0.55) - 0.78) * 2.8;
      const originX = measureRect.left - shellRect.left;
      const originY = measureRect.top - shellRect.top;
      const data = new Float32Array(particles.length * 5);

      for (let index = 0; index < particles.length; index++) {
        const particle = particles[index];
        const baseX = originX + particle.x;
        const baseY = originY + particle.y;
        const dx = baseX - mouseRef.current.x;
        const dy = baseY - mouseRef.current.y;
        const distance = Math.max(1, Math.hypot(dx, dy));
        const hover = !reducedMotion && mouseRef.current.active ? clamp(1 - distance / (particle.isNoise ? 180 : 140), 0, 1) : 0;
        const intro = (1 - easeOutCubic((reveal - particle.delay * 0.42) / 0.58)) * (particle.isNoise ? 54 : 36);
        const drift = reducedMotion ? 0 : Math.sin(now / 780 + index * 0.91) * (particle.isNoise ? 7 : 1.8);
        const charge = hover * (particle.isNoise ? 32 : 20) + burst * (particle.isNoise ? 22 : 10);
        data[index * 5] = clamp(baseX + (dx / distance) * charge + drift, 8, shellRect.width - 8);
        data[index * 5 + 1] = clamp(baseY + (dy / distance) * charge - intro + drift * 0.35, 8, shellRect.height - 8);
        data[index * 5 + 2] = particle.size * (1 + hover * 0.32 + burst * 0.18);
        data[index * 5 + 3] = clamp(particle.alpha * easeOutCubic((reveal - particle.delay * 0.28) / 0.72) * (1 + hover * 1.7 + burst * 0.45), 0, 1);
        data[index * 5 + 4] = particle.morph;
      }

      return { data, count: particles.length, width: shellRect.width, height: shellRect.height };
    }

    function drawFallback(now: number) {
      if (!context2d) return;
      fallbackCanvas.style.opacity = "1";
      const { data, count, width, height } = frameData(now);
      context2d.clearRect(0, 0, width, height);
      const glow = context2d.createRadialGradient(width / 2, height * 0.31, 0, width / 2, height * 0.31, Math.max(width, height) * 0.48);
      glow.addColorStop(0, "rgba(255,255,255,0.13)");
      glow.addColorStop(0.45, "rgba(255,255,255,0.04)");
      glow.addColorStop(1, "rgba(255,255,255,0)");
      context2d.fillStyle = glow;
      context2d.fillRect(0, 0, width, height);
      for (let index = 0; index < count; index++) {
        const x = data[index * 5];
        const y = data[index * 5 + 1];
        const size = data[index * 5 + 2];
        const opacity = data[index * 5 + 3];
        context2d.shadowColor = `rgba(255,255,255,${opacity * 0.42})`;
        context2d.shadowBlur = 16 + opacity * 18;
        context2d.fillStyle = `rgba(245,245,242,${opacity})`;
        context2d.beginPath();
        context2d.roundRect(x - size / 2, y - size / 2, size, size, Math.min(3, size / 3));
        context2d.fill();
      }
      context2d.shadowBlur = 0;
    }

    function drawGpu(now: number) {
      const gpu = gpuRef.current;
      if (!gpu) return false;
      const { data, count, width, height } = frameData(now);
      fallbackCanvas.style.opacity = "0";
      gpu.device.queue.writeBuffer(gpu.uniformBuffer, 0, new Float32Array([width, height, 0, 0]));
      gpu.device.queue.writeBuffer(gpu.instanceBuffer, 0, data);
      const encoder = gpu.device.createCommandEncoder();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: gpu.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        }],
      });
      pass.setPipeline(gpu.pipeline);
      pass.setBindGroup(0, gpu.bindGroup);
      pass.setVertexBuffer(0, gpu.quadBuffer);
      pass.setVertexBuffer(1, gpu.instanceBuffer);
      pass.draw(6, count);
      pass.end();
      gpu.device.queue.submit([encoder.finish()]);
      return true;
    }

    function render(now: number) {
      try {
        if (!drawGpu(now)) drawFallback(now);
      } catch {
        gpuRef.current = null;
        drawFallback(now);
      }
      if (!reducedMotion) animationFrame = requestAnimationFrame(render);
    }

    function updateReducedMotion(event: MediaQueryListEvent) {
      reducedMotion = event.matches;
      cancelAnimationFrame(animationFrame);
      if (reducedMotion) render(performance.now());
      else {
        startRef.current = performance.now();
        animationFrame = requestAnimationFrame(render);
      }
    }

    async function boot() {
      try {
        gpuRef.current = await createGpuResources(gpuCanvas, maximumParticles);
      } catch {
        gpuRef.current = null;
      }
      if (disposed) return;
      resize();
      render(performance.now());
    }

    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    observer.observe(measure);
    motionQuery.addEventListener("change", updateReducedMotion);
    void boot();

    return () => {
      disposed = true;
      observer.disconnect();
      motionQuery.removeEventListener("change", updateReducedMotion);
      cancelAnimationFrame(animationFrame);
    };
  }, [dotMap, maximumParticles]);

  return (
    <div
      ref={shellRef}
      className="pointer-events-auto absolute inset-0 overflow-hidden"
      aria-hidden="true"
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        mouseRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top, active: true };
      }}
      onMouseLeave={() => {
        mouseRef.current = { x: -9999, y: -9999, active: false };
      }}
    >
      <div
        ref={measureRef}
        className="pointer-events-none absolute left-1/2 top-[31%] -translate-x-1/2 -translate-y-1/2 select-none font-pixel text-[clamp(7rem,18vw,13.125rem)] leading-none tracking-[-0.04em] opacity-0"
      >
        {WORD}
      </div>
      <canvas ref={gpuCanvasRef} className="absolute inset-0" />
      <canvas ref={fallbackCanvasRef} className="absolute inset-0" />
    </div>
  );
}
