import type { Draw, Frame, Geometry, Gpu, Surface } from "vgpu";
import { draw, frameLoop, geometry, surface } from "vgpu";
import { perspectiveCamera, sphere } from "vgpu/scene";

import { cameraView, rotationMatrix } from "./camera";
import environmentDebugAxesWgsl from "./environment-debug-axes.wgsl";
import environmentDebugWgsl from "./environment-debug.wgsl";
import { PRISM_GLASS } from "./types";

const SPHERE_RADIUS = 0.68;
const AXIS_LENGTH = 1.02;
const MIN_DISTANCE = 1.75;
const MAX_DISTANCE = 4.5;
const MAX_PITCH = Math.PI * 0.47;
// Derive the spherical orbit from the main renderer's resting camera. This
// keeps both initial view directions identical even if its defaults move later.
const INITIAL_ORBIT = orbitFromPosition(cameraView(1).position);
const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);
// The gizmo is deliberately world-aligned. It remains a stable global reference
// even if the environment itself gets a non-zero rotation again later.
const GLOBAL_AXES_MODEL = rotationMatrix([0, 0, 0]);

export interface EnvironmentDebugRenderer {
  readonly ready: Promise<void>;
  dispose(): void;
}

export interface EnvironmentDebugRendererOptions {
  readonly canvas: HTMLCanvasElement;
  readonly onError?: (error: unknown) => void;
}

/** Optional mirror-ball inspector; constructed only while its lil-gui toggle is on. */
export function createEnvironmentDebugRenderer(
  options: EnvironmentDebugRendererOptions,
): EnvironmentDebugRenderer {
  let disposed = false;
  let reportedError = false;
  let gpu: Gpu | undefined;
  let canvasSurface: Surface | undefined;
  let mirror: Draw | undefined;
  let axes: Draw | undefined;
  let mirrorGeometry: Geometry | undefined;
  let axesGeometry: Geometry | undefined;
  let loop: { stop(): void } | undefined;
  let observer: ResizeObserver | undefined;
  let pointerId: number | undefined;
  let lastPointer: readonly [number, number] = [0, 0];
  let yaw = INITIAL_ORBIT.yaw;
  let pitch = INITIAL_ORBIT.pitch;
  let distance = INITIAL_ORBIT.distance;
  let pendingPresent = true;

  const invalidate = () => {
    pendingPresent = true;
  };

  const resize = () => {
    if (!canvasSurface) return;
    const rect = options.canvas.getBoundingClientRect();
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvasSurface.resize([
      Math.max(1, Math.round(rect.width * dpr)),
      Math.max(1, Math.round(rect.height * dpr)),
    ]);
    invalidate();
  };

  const onPointerDown = (event: PointerEvent) => {
    if (!event.isPrimary) return;
    pointerId = event.pointerId;
    lastPointer = [event.clientX, event.clientY];
    options.canvas.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - lastPointer[0];
    const dy = event.clientY - lastPointer[1];
    lastPointer = [event.clientX, event.clientY];
    yaw -= dx * 0.01;
    pitch = clamp(pitch + dy * 0.01, -MAX_PITCH, MAX_PITCH);
    invalidate();
  };

  const onPointerUp = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    if (options.canvas.hasPointerCapture(event.pointerId)) {
      options.canvas.releasePointerCapture(event.pointerId);
    }
    pointerId = undefined;
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();
    distance = clamp(distance + event.deltaY * 0.002, MIN_DISTANCE, MAX_DISTANCE);
    invalidate();
  };

  const pointerListeners: readonly [
    "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
    (event: PointerEvent) => void,
  ][] = [
    ["pointerdown", onPointerDown],
    ["pointermove", onPointerMove],
    ["pointerup", onPointerUp],
    ["pointercancel", onPointerUp],
  ];
  for (const [name, listener] of pointerListeners) {
    options.canvas.addEventListener(name, listener);
  }
  options.canvas.addEventListener("wheel", onWheel, { passive: false });

  const handleFailure = (error: unknown) => {
    if (disposed) return;
    if (!reportedError) {
      reportedError = true;
      try { options.onError?.(error); } catch { /* reporting must not block teardown */ }
    }
    dispose();
  };

  const tick = (currentFrame: Frame) => {
    if (disposed || !pendingPresent || !canvasSurface || !mirror || !axes) return;
    try {
      const mirrorDraw = mirror;
      const axesDraw = axes;
      const cameraPosition = orbitPosition(yaw, pitch, distance);
      const camera = perspectiveCamera({
        fov: 38,
        aspect: canvasSurface.size[0] / Math.max(1, canvasSurface.size[1]),
        near: 0.05,
        far: 10,
        position: cameraPosition,
        target: [0, 0, 0],
      });
      mirror.set({
        params: {
          viewProjection: camera.viewProjection,
          environmentRotation: ENVIRONMENT_ROTATION,
          cameraPosition,
          environmentExposure: PRISM_GLASS.environmentExposure,
        },
      });
      axes.set({
        params: {
          viewProjection: camera.viewProjection,
          model: GLOBAL_AXES_MODEL,
          resolution: canvasSurface.size,
          lineWidth: 2,
          opacity: 0.95,
        },
      });
      currentFrame.pass({ target: canvasSurface, clear: [0.008, 0.008, 0.012, 1] }, (pass) => {
        pass.draw(mirrorDraw);
        pass.draw(axesDraw);
      });
      pendingPresent = false;
    } catch (error) {
      handleFailure(error);
    }
  };

  const initialize = async () => {
    const { init } = await import("vgpu");
    if (disposed) return;
    const nextGpu = await init();
    if (disposed) {
      nextGpu.dispose();
      return;
    }
    gpu = nextGpu;
    canvasSurface = surface(gpu, options.canvas, { dpr: [1, 2] });
    mirrorGeometry = geometry(gpu, sphere({
      radius: SPHERE_RADIUS,
      widthSegments: 48,
      heightSegments: 24,
    }));
    axesGeometry = createAxesGeometry(gpu);
    mirror = draw(gpu, {
      shader: environmentDebugWgsl,
      geometry: mirrorGeometry,
      cull: "back",
      depth: false,
      label: "prism-environment-debug-mirror",
    });
    axes = draw(gpu, {
      shader: environmentDebugAxesWgsl,
      geometry: axesGeometry,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: "prism-environment-debug-axes",
    });
    const outputSignature = { colors: [canvasSurface.format] } as const;
    await Promise.all([
      mirror.compile(outputSignature),
      axes.compile(outputSignature),
    ]);
    if (disposed) return;
    observer = new ResizeObserver(resize);
    observer.observe(options.canvas);
    resize();
    loop = frameLoop(gpu, tick);
  };

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    loop?.stop();
    loop = undefined;
    observer?.disconnect();
    observer = undefined;
    for (const [name, listener] of pointerListeners) {
      options.canvas.removeEventListener(name, listener);
    }
    options.canvas.removeEventListener("wheel", onWheel);
    if (pointerId !== undefined && options.canvas.hasPointerCapture(pointerId)) {
      options.canvas.releasePointerCapture(pointerId);
    }
    pointerId = undefined;
    mirrorGeometry?.destroy();
    mirrorGeometry = undefined;
    axesGeometry?.destroy();
    axesGeometry = undefined;
    canvasSurface?.dispose();
    canvasSurface = undefined;
    gpu?.dispose();
    gpu = undefined;
  }

  const ready = initialize().catch((error: unknown) => {
    if (!disposed) handleFailure(error);
    throw error;
  });

  return { ready, dispose };
}

function createAxesGeometry(gpu: Gpu): Geometry {
  const vertices: number[] = [];
  const corners = [
    [0, -1], [0, 1], [1, 1],
    [0, -1], [1, 1], [1, -1],
  ] as const;
  const axes = [
    { end: [AXIS_LENGTH, 0, 0], color: [1, 0.08, 0.05] },
    { end: [0, AXIS_LENGTH, 0], color: [0.1, 0.82, 0.2] },
    { end: [0, 0, AXIS_LENGTH], color: [0.08, 0.4, 1] },
  ] as const;
  for (const axis of axes) {
    for (const corner of corners) {
      vertices.push(0, 0, 0, ...axis.end, ...axis.color, ...corner);
    }
  }
  return geometry(gpu, {
    label: "prism-environment-debug-axes-geometry",
    buffers: [{
      data: new Float32Array(vertices),
      stride: 44,
      attributes: {
        lineStart: "float32x3",
        lineEnd: "float32x3",
        axisColor: "float32x3",
        corner: "float32x2",
      },
    }],
  });
}

function orbitPosition(
  yaw: number,
  pitch: number,
  distance: number,
): readonly [number, number, number] {
  const cosPitch = Math.cos(pitch);
  return [
    Math.sin(yaw) * cosPitch * distance,
    Math.sin(pitch) * distance,
    Math.cos(yaw) * cosPitch * distance,
  ];
}

function orbitFromPosition(position: readonly [number, number, number]): {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
} {
  const distance = Math.hypot(position[0], position[1], position[2]) || 1;
  return {
    yaw: Math.atan2(position[0], position[2]),
    pitch: Math.asin(clamp(position[1] / distance, -1, 1)),
    distance,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
