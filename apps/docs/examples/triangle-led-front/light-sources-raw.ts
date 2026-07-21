import type { Bundle, Frame, FramePass, Gpu, Target } from 'vgpu';

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

export interface LightSourcesRaw {
  readonly texture: Target;
  readonly ready?: Promise<void>;
  encode(args: {
    frame: Frame;
    brush: BrushState;
    time: number;
    tunables: LightTunables;
    renderBlackOccluder?: boolean;
  }): void;
  destroy(): void;
}

interface CreateLightSourcesRawOptions {
  size: readonly [number, number];
  ledStorage: unknown;
  ledRadius?: number;
  ledShape?: ReturnType<typeof triangleLedShapeDimensions>;
  triangle?: ReturnType<typeof canonicalTriangleGeometry>;
}

export function createLightSourcesRaw(
  gpu: Gpu,
  opts: CreateLightSourcesRawOptions,
): LightSourcesRaw {
  const simSize: RenderSize = { width: opts.size[0], height: opts.size[1] };
  const triangle = opts.triangle ?? canonicalTriangleGeometry(simSize);
  const ledRadius = opts.ledRadius ?? triangleLedRadius(simSize);
  const ledShape =
    opts.ledShape ?? triangleLedShapeDimensions(simSize, LEDS_PER_EDGE);

  const target = gpu.target({
    size: [simSize.width, simSize.height],
    format: LIGHT_SOURCES_FORMAT,
    label: 'triangle-led-front-light-sources',
  });

  const ledVertices = ledEmitterVertexData(
    simSize,
    LED_EMITTER_MESH_EXPANSION_PX,
  );
  const ledMesh = gpu.mesh({
    label: 'triangle-led-front-led-emitters',
    buffers: [{
      data: ledVertices.buffer as ArrayBuffer,
      stride: 24,
      attributes: {
        position: 'float32x2',
        local: 'float32x2',
        led_index: 'float32',
      },
    }],
  });

  const lightSourcesDraw = gpu.draw({
    shader: lightSourcesWgsl,
    label: 'triangle-led-front-light-sources-pass',
    vertices: 3,
    set: { cfg: initialLightSourcesUniform(), leds: opts.ledStorage },
  });
  const ledEmittersDraw = gpu.draw({
    shader: ledEmittersWgsl,
    label: 'triangle-led-front-led-emitters-pass',
    mesh: ledMesh,
    blend: {
      color: { src: 'one', dst: 'zero' },
      alpha: { src: 'one', dst: 'one', op: 'min' },
    },
    writeMask: ['r', 'g', 'b'],
    set: { cfg: initialLightSourcesUniform(), leds: opts.ledStorage },
  });

  const ready = Promise.all([
    lightSourcesDraw.compile(target),
    ledEmittersDraw.compile(target),
  ]).then(() => undefined);

  const recordClearBundle = (): Bundle => gpu.bundle(
    { target, label: 'triangle-led-front-light-sources-clear' },
    (bundle) => {
      bundle.draw(lightSourcesDraw);
      bundle.draw(ledEmittersDraw);
    },
  );
  const emittersBundle = gpu.bundle(
    { target, label: 'triangle-led-front-led-emitters' },
    (bundle) => bundle.draw(ledEmittersDraw),
  );
  let clearBundle = recordClearBundle();
  let lastBakeKey: string | undefined;

  return {
    texture: target,
    ready,
    encode({ frame, brush, time, tunables, renderBlackOccluder = true }) {
      const sanitizedClipInset = sanitizeTunablePx(
        tunables.ledRaycastClipInsetPx,
        TUNABLE_RANGES.ledRaycastClipInsetPx,
        TUNABLE_DEFAULTS.ledRaycastClipInsetPx,
      );
      const uniformData = lightSourcesUniform(
        simSize,
        brush,
        time,
        tunables,
        ledRadius,
        ledShape,
        triangle,
        renderBlackOccluder,
        sanitizedClipInset,
      );
      lightSourcesDraw.set({ cfg: uniformData });
      ledEmittersDraw.set({ cfg: uniformData });
      const bakeKey = `${renderBlackOccluder ? 1 : 0}:${sanitizedClipInset}`;

      if (bakeKey !== lastBakeKey) {
        clearBundle = recordClearBundle();
        lastBakeKey = bakeKey;
        frame.pass(
          { target, clear: [0, 0, 0, 1000] },
          (pass: FramePass) => pass.bundles(clearBundle),
        );
      } else {
        frame.pass(
          { target, clear: false },
          (pass: FramePass) => pass.bundles(emittersBundle),
        );
      }
    },
    destroy() {
      (target as { destroy?: () => void }).destroy?.();
      ledMesh.destroy();
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
  sanitizedClipInset: number,
) {
  return {
    resolution: [size.width, size.height],
    time,
    floor_albedo: tunables.darkFloorAlbedo,
    brush: [brush.x, brush.y, brush.active ? 1 : 0, brush.radius],
    colour: [brush.colour.r, brush.colour.g, brush.colour.b, 0],
    tunables: [
      tunables.ledIntensity,
      tunables.brightnessMin,
      tunables.brightnessMax,
      ledRadius,
    ],
    triangle: [
      triangle.center.x,
      triangle.center.y,
      triangle.circumradius,
      triangle.sideLength * 0.5,
    ],
    options: [
      renderBlackOccluder ? 1 : 0,
      tunables.ledHitThreshold,
      ledShape.tangentHalfLength,
      ledShape.normalHalfThickness,
    ],
    led_clip: [
      LED_SDF_CROP_EXPANSION_PX,
      sanitizedClipInset,
      0,
      0,
    ],
  };
}

function initialLightSourcesUniform() {
  return {
    resolution: [0, 0],
    time: 0,
    floor_albedo: 0,
    brush: [0, 0, 0, 0],
    colour: [0, 0, 0, 0],
    tunables: [0, 0, 0, 0],
    triangle: [0, 0, 0, 0],
    options: [0, 0, 0, 0],
    led_clip: [0, 0, 0, 0],
  };
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
