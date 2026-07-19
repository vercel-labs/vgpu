import type { Device, Texture } from '@vgpu/core';

import lightSourcesWgsl from './shaders/light-sources.wgsl';
import ledEmittersWgsl from './shaders/led-emitters.wgsl';
import {
  LEDS_PER_EDGE,
  LED_EMITTER_MESH_EXPANSION_PX,
  LED_SDF_CROP_EXPANSION_PX,
  TUNABLE_DEFAULTS,
  TUNABLE_RANGES,
  canonicalTriangleGeometry,
  triangleEdgeLedLayout,
  triangleLedRadius,
  triangleLedShapeDimensions,
  type RenderSize,
} from './settings';
import type { BrushState, SceneTunables as LightTunables } from './light-sources-pass';

const LIGHT_SOURCES_FORMAT: GPUTextureFormat = 'rgba16float';
const LED_EMITTER_VERTEX_FLOATS = 6;

export interface LightSourcesRaw {
  readonly texture: Texture | GPUTexture;
  readonly ready?: Promise<void>;
  encode(args: {
    brush: BrushState;
    time: number;
    tunables: LightTunables;
    renderBlackOccluder?: boolean;
  }): void;
  destroy(): void;
}

interface CreateLightSourcesRawOptions {
  size: readonly [number, number];
  ledStorage: GPUBuffer;
  ledRadius?: number;
  ledShape?: ReturnType<typeof triangleLedShapeDimensions>;
  triangle?: ReturnType<typeof canonicalTriangleGeometry>;
}

export function createLightSourcesRaw(
  gpu: { device: Device; gpu: GPUDevice },
  opts: CreateLightSourcesRawOptions,
): LightSourcesRaw {
  const device = gpu.device;
  const simSize: RenderSize = { width: opts.size[0], height: opts.size[1] };
  const triangle = opts.triangle ?? canonicalTriangleGeometry(simSize);
  const ledRadius = opts.ledRadius ?? triangleLedRadius(simSize);
  const ledShape =
    opts.ledShape ?? triangleLedShapeDimensions(simSize, LEDS_PER_EDGE);

  const texture = device.createTexture({
    size: [simSize.width, simSize.height],
    format: LIGHT_SOURCES_FORMAT,
    usage: ['render_attachment', 'texture_binding', 'copy_src'],
    label: 'triangle-led-front-light-sources',
  });
  const textureView = texture.createView();

  const uniform = device.createBuffer({
    size: 112,
    usage: ['uniform', 'copy_dst'],
    label: 'triangle-led-front-light-sources-uniform',
  });

  const ledVertices = ledEmitterVertexData(
    simSize,
    LED_EMITTER_MESH_EXPANSION_PX,
  );
  const ledVertexBuffer = device.createBuffer({
    size: ledVertices.byteLength,
    usage: ['vertex', 'copy_dst'],
    label: 'triangle-led-front-led-emitters-vertices',
  });
  ledVertexBuffer.write(ledVertices.buffer as ArrayBuffer);
  const ledVertexCount = ledVertices.length / LED_EMITTER_VERTEX_FLOATS;

  const bindGroupLayout = device.gpu.createBindGroupLayout({
    label: 'triangle-led-front-light-sources-layout',
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: 'uniform' },
      },
      {
        binding: 1,
        visibility: GPUShaderStage.FRAGMENT,
        buffer: { type: 'read-only-storage' },
      },
    ],
  });
  const pipelineLayout = device.gpu.createPipelineLayout({
    label: 'triangle-led-front-light-sources-pipeline-layout',
    bindGroupLayouts: [bindGroupLayout],
  });

  const lightSourcesModule = device.createShader(lightSourcesWgsl).gpu;
  const ledEmittersModule = device.createShader(ledEmittersWgsl).gpu;

  const lightSourcesPipelineDesc: GPURenderPipelineDescriptor = {
    label: 'triangle-led-front-light-sources-pass',
    layout: pipelineLayout,
    vertex: { module: lightSourcesModule, entryPoint: 'vs_main' },
    fragment: {
      module: lightSourcesModule,
      entryPoint: 'fs_main',
      targets: [{ format: LIGHT_SOURCES_FORMAT }],
    },
    primitive: { topology: 'triangle-list' },
  };
  const ledEmittersPipelineDesc: GPURenderPipelineDescriptor = {
    label: 'triangle-led-front-led-emitters-pass',
    layout: pipelineLayout,
    vertex: {
      module: ledEmittersModule,
      entryPoint: 'vs_main',
      buffers: [
        {
          arrayStride: 24,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x2' },
            { shaderLocation: 1, offset: 8, format: 'float32x2' },
            { shaderLocation: 2, offset: 16, format: 'float32' },
          ],
        },
      ],
    },
    fragment: {
      module: ledEmittersModule,
      entryPoint: 'fs_main',
      targets: [
        {
          format: LIGHT_SOURCES_FORMAT,
          blend: {
            color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'min' },
          },
          writeMask: 0x7,
        },
      ],
    },
    primitive: { topology: 'triangle-list' },
  };

  const lightSourcesPipeline = device.gpu.createRenderPipeline(
    lightSourcesPipelineDesc,
  );
  const ledEmittersPipeline = device.gpu.createRenderPipeline(
    ledEmittersPipelineDesc,
  );

  const ready = Promise.all([
    device.gpu.createRenderPipelineAsync(lightSourcesPipelineDesc),
    device.gpu.createRenderPipelineAsync(ledEmittersPipelineDesc),
  ]).then(() => undefined);

  const bindGroup = device.gpu.createBindGroup({
    label: 'triangle-led-front-light-sources-bind-group',
    layout: bindGroupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform.gpu } },
      { binding: 1, resource: { buffer: opts.ledStorage } },
    ],
  });

  let lastBakeKey: string | undefined;

  return {
    texture,
    ready,
    encode({ brush, time, tunables, renderBlackOccluder = true }) {
      const uniformData = lightSourcesUniform(
        simSize,
        brush,
        time,
        tunables,
        ledRadius,
        ledShape,
        triangle,
        renderBlackOccluder,
      );
      uniform.write(uniformData.buffer as ArrayBuffer);
      const bakeKey = `${renderBlackOccluder ? 1 : 0}:${uniformData[25]}`;
      const encoder = gpu.gpu.createCommandEncoder();

      if (bakeKey !== lastBakeKey) {
        lastBakeKey = bakeKey;
        const pass = encoder.beginRenderPass({
          label: 'triangle-led-front-light-sources-prepass',
          colorAttachments: [
            {
              view: textureView,
              loadOp: 'clear',
              storeOp: 'store',
              clearValue: [0, 0, 0, 1000],
            },
          ],
        });
        pass.setPipeline(lightSourcesPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.draw(3);
        pass.setPipeline(ledEmittersPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, ledVertexBuffer.gpu);
        pass.draw(ledVertexCount);
        pass.end();
      } else {
        const pass = encoder.beginRenderPass({
          label: 'triangle-led-front-led-emitters-pass',
          colorAttachments: [
            {
              view: textureView,
              loadOp: 'load',
              storeOp: 'store',
            },
          ],
        });
        pass.setPipeline(ledEmittersPipeline);
        pass.setBindGroup(0, bindGroup);
        pass.setVertexBuffer(0, ledVertexBuffer.gpu);
        pass.draw(ledVertexCount);
        pass.end();
      }

      gpu.gpu.queue.submit([encoder.finish()]);
    },
    destroy() {
      texture.gpu.destroy();
      uniform.gpu.destroy();
      ledVertexBuffer.gpu.destroy();
    },
  };
}

function lightSourcesUniform(
  size: RenderSize,
  brush: BrushState,
  time: number,
  tunables: LightTunables,
  ledRadius: number,
  ledShape: ReturnType<typeof triangleLedShapeDimensions>,
  triangle: ReturnType<typeof canonicalTriangleGeometry>,
  renderBlackOccluder: boolean,
): Float32Array {
  const out = new Float32Array(28);
  out.set([size.width, size.height, time, tunables.darkFloorAlbedo], 0);
  out.set([brush.x, brush.y, brush.active ? 1 : 0, brush.radius], 4);
  out.set([brush.colour.r, brush.colour.g, brush.colour.b, 0], 8);
  out.set(
    [
      tunables.ledIntensity,
      tunables.brightnessMin,
      tunables.brightnessMax,
      ledRadius,
    ],
    12,
  );
  out.set(
    [
      triangle.center.x,
      triangle.center.y,
      triangle.circumradius,
      triangle.sideLength * 0.5,
    ],
    16,
  );
  out.set(
    [
      renderBlackOccluder ? 1 : 0,
      tunables.ledHitThreshold,
      ledShape.tangentHalfLength,
      ledShape.normalHalfThickness,
    ],
    20,
  );
  out.set(
    [
      LED_SDF_CROP_EXPANSION_PX,
      sanitizeTunablePx(
        tunables.ledRaycastClipInsetPx,
        TUNABLE_RANGES.ledRaycastClipInsetPx,
        TUNABLE_DEFAULTS.ledRaycastClipInsetPx,
      ),
      0,
      0,
    ],
    24,
  );
  return out;
}

function sanitizeTunablePx(
  value: number,
  range: { min: number; max: number },
  fallback: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(range.max, Math.max(range.min, value));
}

function ledEmitterVertexData(
  size: RenderSize,
  pad: number,
): Float32Array {
  const layout = triangleEdgeLedLayout(size, LEDS_PER_EDGE);
  const { tangentHalfLength, normalHalfThickness } = layout.ledShape;
  const paddedHalfLength = tangentHalfLength + pad;
  const paddedHalfThickness = normalHalfThickness + pad;
  const values: number[] = [];

  const pushVertex = (
    ledIndex: number,
    x: number,
    y: number,
    t: number,
    n: number,
  ) => {
    values.push(x, y, t, n, ledIndex, 0);
  };

  const pushQuad = (
    ledIndex: number,
    center: { x: number; y: number },
    edgeDir: { x: number; y: number },
    edgeNormal: { x: number; y: number },
    startT: number,
    endT: number,
    minN: number,
    maxN: number,
  ) => {
    const corners = [
      { t: startT, n: minN },
      { t: endT, n: minN },
      { t: endT, n: maxN },
      { t: startT, n: maxN },
    ] as const;
    const indices = [0, 1, 2, 0, 2, 3] as const;
    for (const cornerIndex of indices) {
      const corner = corners[cornerIndex];
      pushVertex(
        ledIndex,
        center.x + edgeDir.x * corner.t + edgeNormal.x * corner.n,
        center.y + edgeDir.y * corner.t + edgeNormal.y * corner.n,
        corner.t,
        corner.n,
      );
    }
  };

  for (const [ledIndex, led] of layout.positions.entries()) {
    const basis = edgeBasis(led.angle ?? 0);
    pushQuad(
      ledIndex,
      led,
      basis.dir,
      basis.normal,
      -paddedHalfLength,
      paddedHalfLength,
      -paddedHalfThickness,
      paddedHalfThickness,
    );
  }

  const triangleVertices = [
    layout.geometry.top,
    layout.geometry.left,
    layout.geometry.right,
  ] as const;
  for (let edge = 0; edge < 3; edge++) {
    const prevEdge = (edge + 2) % 3;
    const incomingLed = prevEdge * LEDS_PER_EDGE + LEDS_PER_EDGE - 1;
    const outgoingLed = edge * LEDS_PER_EDGE;
    const incoming = layout.positions[incomingLed];
    const outgoing = layout.positions[outgoingLed];
    const corner = triangleVertices[edge];
    if (!incoming || !outgoing || !corner) continue;

    const incomingBasis = edgeBasis(incoming.angle ?? 0);
    const outgoingBasis = edgeBasis(outgoing.angle ?? 0);
    const incomingEnd = {
      x: incoming.x + incomingBasis.dir.x * paddedHalfLength,
      y: incoming.y + incomingBasis.dir.y * paddedHalfLength,
    };
    const outgoingStart = {
      x: outgoing.x - outgoingBasis.dir.x * paddedHalfLength,
      y: outgoing.y - outgoingBasis.dir.y * paddedHalfLength,
    };
    const inwardBisector = normalize({
      x: incomingEnd.x + outgoingStart.x - corner.x * 2,
      y: incomingEnd.y + outgoingStart.y - corner.y * 2,
    });
    const seam = {
      x:
        corner.x +
        inwardBisector.x * (layout.ledShape.cornerTrim + paddedHalfLength),
      y:
        corner.y +
        inwardBisector.y * (layout.ledShape.cornerTrim + paddedHalfLength),
    };
    const incomingBoundary = fartherPoint(
      offsetPoint(incomingEnd, incomingBasis.normal, -paddedHalfThickness),
      offsetPoint(incomingEnd, incomingBasis.normal, paddedHalfThickness),
      outgoingStart,
    );
    const outgoingBoundary = fartherPoint(
      offsetPoint(outgoingStart, outgoingBasis.normal, -paddedHalfThickness),
      offsetPoint(outgoingStart, outgoingBasis.normal, paddedHalfThickness),
      incomingEnd,
    );

    const outerMiter =
      lineIntersection(
        incomingBoundary,
        incomingBasis.dir,
        outgoingBoundary,
        outgoingBasis.dir,
      ) ?? corner;

    pushVertex(incomingLed, outerMiter.x, outerMiter.y, tangentHalfLength, 0);
    pushVertex(
      incomingLed,
      incomingBoundary.x,
      incomingBoundary.y,
      paddedHalfLength,
      incomingBoundary.n,
    );
    pushVertex(incomingLed, seam.x, seam.y, tangentHalfLength, 0);

    pushVertex(outgoingLed, outerMiter.x, outerMiter.y, -tangentHalfLength, 0);
    pushVertex(outgoingLed, seam.x, seam.y, -tangentHalfLength, 0);
    pushVertex(
      outgoingLed,
      outgoingBoundary.x,
      outgoingBoundary.y,
      -paddedHalfLength,
      outgoingBoundary.n,
    );
  }

  return new Float32Array(values);
}

function edgeBasis(angle: number) {
  const dir = { x: Math.cos(angle), y: Math.sin(angle) };
  return { dir, normal: { x: -dir.y, y: dir.x } };
}

function normalize(v: { x: number; y: number }) {
  const length = Math.hypot(v.x, v.y);
  if (length <= 0) return { x: 0, y: 0 };
  return { x: v.x / length, y: v.y / length };
}

function offsetPoint(
  point: { x: number; y: number },
  normal: { x: number; y: number },
  n: number,
) {
  return { x: point.x + normal.x * n, y: point.y + normal.y * n, n };
}

function fartherPoint<T extends { x: number; y: number }>(
  a: T,
  b: T,
  from: { x: number; y: number },
): T {
  return distanceSquared(a, from) >= distanceSquared(b, from) ? a : b;
}

function distanceSquared(
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function lineIntersection(
  p: { x: number; y: number },
  pd: { x: number; y: number },
  q: { x: number; y: number },
  qd: { x: number; y: number },
): { x: number; y: number } | undefined {
  const denom = pd.x * qd.y - pd.y * qd.x;
  if (Math.abs(denom) < 1e-6) return undefined;
  const s = ((q.x - p.x) * qd.y - (q.y - p.y) * qd.x) / denom;
  return { x: p.x + pd.x * s, y: p.y + pd.y * s };
}
