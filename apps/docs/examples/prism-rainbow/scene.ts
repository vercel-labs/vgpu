/**
 * Deterministic scene graph.
 *
 * The CPU traces wavelength-connected sheets across the finite beam and writes
 * them into one fixed vertex buffer. Every rendered frame then has three cheap
 * stages: rasterize that mesh additively into a linear-light target, combine
 * that target with the wall, and finally draw the transmissive prism over it.
 * There is no temporal history, stochastic sampling or convergence state.
 */

import type { Buffer, Draw, Effect, Frame, Geometry, Gpu, Surface, Target } from "vgpu";
import { draw, effect, frame, sampler, target } from "vgpu";

import { cameraView, rotationMatrix, wallHalfHeight, type CameraView } from "./camera";
import glassWgsl from "./glass.wgsl";
import {
  buildLightMesh,
  LIGHT_VERTEX_STRIDE,
  lightVertexCount,
  type LightMeshStats,
} from "./light-mesh";
import lightWgsl from "./light.wgsl";
import presentWgsl from "./present.wgsl";
import { prismGeometry } from "./prism-mesh";
import wallWgsl from "./wall.wgsl";
import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_BACK_Z,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_FRONT_Z,
  PRISM_GLASS,
  PRISM_INCIDENCE_ARC,
  PRISM_TRIANGLE,
  clampBeamWidth,
  lampForIncidence,
  type PrismControls,
  type CollimatedLight,
} from "./types";

type Output = Surface | Target;
const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);

export interface PrismScene {
  readonly gpu: Gpu;
  outputSize: readonly [number, number];
  wallTarget?: Target;
  lightTarget?: Target;
  readonly light: Draw;
  readonly lightBuffer: Buffer;
  lightStats: LightMeshStats;
  readonly wall: Draw;
  readonly present: Effect;
  readonly glass: Draw;
  readonly prism: Geometry;
  readonly sceneSampler: ReturnType<typeof sampler>;
  controls: PrismControls;
  lampArc: number;
  orbit: readonly [number, number];
  aspect: number;
  view: CameraView;
  readonly label: string;
}

export function createScene(
  gpu: Gpu,
  output: readonly [number, number],
  label: string,
): PrismScene {
  const aspect = output[0] / Math.max(1, output[1]);
  const initialMesh = buildLightMesh({
    light: lampAt(PRISM_DEFAULT_ARC, DEFAULT_PRISM_CONTROLS.beamWidth),
    dispersion: PRISM_DISPERSION_PRESETS[DEFAULT_PRISM_CONTROLS.dispersion],
    wallHalfExtent: wallExtent(aspect),
  });
  const lightBuffer = gpu.device.createBuffer({
    size: initialMesh.vertices.byteLength,
    usage: ["vertex", "copy_dst"],
    label: `${label}.light-vertices`,
  });
  lightBuffer.write(initialMesh.vertices);
  const prism = prismGeometry(gpu, `${label}.prism`);
  return {
    gpu,
    outputSize: output,
    light: draw(gpu, {
      shader: lightWgsl,
      geometry: {
        vertexBuffers: [lightBuffer.gpu],
        vertexBufferLayouts: [{
          arrayStride: LIGHT_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 8, format: "float32" },
            { shaderLocation: 2, offset: 12, format: "float32" },
            { shaderLocation: 3, offset: 16, format: "float32" },
          ],
        }],
        vertexCount: lightVertexCount(),
      },
      blend: "additive",
      cull: "none",
      depth: false,
      label: `${label}.light`,
    }),
    lightBuffer,
    lightStats: initialMesh.stats,
    wall: draw(gpu, {
      shader: wallWgsl,
      vertices: 6,
      cull: "back",
      depth: false,
      label: `${label}.wall`,
    }),
    present: effect(gpu, presentWgsl, { label: `${label}.present` }),
    glass: draw(gpu, {
      shader: glassWgsl,
      geometry: prism,
      cull: "back",
      depth: false,
      label: `${label}.glass`,
    }),
    prism,
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
    controls: DEFAULT_PRISM_CONTROLS,
    lampArc: PRISM_DEFAULT_ARC,
    orbit: [0, 0],
    aspect,
    view: cameraView(aspect),
    label,
  };
}

function refreshCamera(scene: PrismScene): void {
  scene.view = cameraView(scene.aspect, scene.orbit[0], scene.orbit[1]);
}

function refreshLightMesh(scene: PrismScene): void {
  const mesh = buildLightMesh({
    light: lampAt(scene.lampArc, scene.controls.beamWidth),
    dispersion: PRISM_DISPERSION_PRESETS[scene.controls.dispersion],
    wallHalfExtent: wallExtent(scene.aspect),
  });
  scene.lightBuffer.write(mesh.vertices);
  scene.lightStats = mesh.stats;
}

export function setControls(scene: PrismScene, controls: PrismControls): void {
  const next = {
    ...controls,
    // Runtime fallback keeps Fast Refresh safe across the control schema change.
    beamWidth: clampBeamWidth(controls.beamWidth ?? DEFAULT_PRISM_CONTROLS.beamWidth),
  };
  const opticsChanged = next.dispersion !== scene.controls.dispersion
    || next.beamWidth !== scene.controls.beamWidth;
  scene.controls = next;
  if (opticsChanged) refreshLightMesh(scene);
}

export function setLampArc(scene: PrismScene, position: number): void {
  const next = Math.min(1, Math.max(0, position));
  if (next === scene.lampArc) return;
  scene.lampArc = next;
  refreshLightMesh(scene);
}

export function setOrbit(scene: PrismScene, x: number, y: number): void {
  scene.orbit = [Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y))];
  refreshCamera(scene);
}

export function resizeScene(scene: PrismScene, output: readonly [number, number]): void {
  scene.outputSize = output;
  scene.aspect = output[0] / Math.max(1, output[1]);
  scene.wallTarget?.resize(output);
  scene.lightTarget?.resize(output);
  refreshCamera(scene);
  refreshLightMesh(scene);
}

export function incidenceAt(position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return PRISM_INCIDENCE_ARC.min
    + (PRISM_INCIDENCE_ARC.max - PRISM_INCIDENCE_ARC.min) * clamped;
}

export function lampAt(
  position: number,
  beamWidth = DEFAULT_PRISM_CONTROLS.beamWidth,
): CollimatedLight {
  return lampForIncidence(incidenceAt(position), beamWidth);
}

export function wallExtent(aspect: number): readonly [number, number] {
  const halfHeight = wallHalfHeight(aspect);
  return [halfHeight * aspect, halfHeight];
}

/** Kept as one shared block so wall, ribbons and glass cannot drift apart. */
export function sceneUniforms(scene: PrismScene): Record<string, unknown> {
  const wallColor = scene.controls.wallColor.match(/^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i);
  return {
    viewProjection: scene.view.camera.viewProjection,
    wallHalfExtent: wallExtent(scene.aspect),
    wallColor: wallColor
      ? wallColor.slice(1).map((channel) => Number.parseInt(channel, 16) / 255)
      : [0, 0, 0],
    causticOnly: scene.controls.view === "caustic" ? 1 : 0,
  };
}

export function glassUniforms(scene: PrismScene): Record<string, unknown> {
  return {
    viewProjection: scene.view.camera.viewProjection,
    environmentRotation: ENVIRONMENT_ROTATION,
    cameraPosition: scene.view.position,
    absorption: PRISM_GLASS.absorption,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    resolution: scene.outputSize,
    frontZ: PRISM_FRONT_Z,
    backZ: PRISM_BACK_Z,
    ior: PRISM_GLASS.ior,
    reflectionStrength: PRISM_GLASS.reflectionStrength,
    frostRadius: PRISM_GLASS.frostRadius,
    dispersion: PRISM_GLASS.dispersion,
    iridescenceStrength: PRISM_GLASS.iridescenceStrength,
    iridescenceFrequency: PRISM_GLASS.iridescenceFrequency,
    environmentExposure: PRISM_GLASS.environmentExposure,
  };
}

export async function prepareScene(scene: PrismScene, output: Output): Promise<void> {
  scene.outputSize = output.size;
  scene.aspect = output.size[0] / Math.max(1, output.size[1]);
  refreshCamera(scene);
  refreshLightMesh(scene);
  const wallTarget = scene.wallTarget ?? target(scene.gpu, {
    size: output.size,
    format: output.format,
    label: `${scene.label}.wall`,
  });
  const lightTarget = scene.lightTarget ?? target(scene.gpu, {
    size: output.size,
    format: "rgba16float",
    label: `${scene.label}.light`,
  });
  scene.wallTarget = wallTarget;
  scene.lightTarget = lightTarget;
  if (wallTarget.size[0] !== output.size[0] || wallTarget.size[1] !== output.size[1]) {
    wallTarget.resize(output.size);
  }
  if (lightTarget.size[0] !== output.size[0] || lightTarget.size[1] !== output.size[1]) {
    lightTarget.resize(output.size);
  }
  bind(scene, wallTarget, lightTarget);
  const outputSignature = { colors: [output.format] } as const;
  await Promise.all([
    scene.light.compile(lightTarget),
    scene.wall.compile(wallTarget),
    scene.present.compile(outputSignature),
    scene.glass.compile(outputSignature),
  ]);
}

export function presentScene(scene: PrismScene, output: Output, currentFrame?: Frame): void {
  const wallTarget = scene.wallTarget;
  const lightTarget = scene.lightTarget;
  if (!wallTarget || !lightTarget) throw new Error("prepareScene must run before presentScene.");
  bind(scene, wallTarget, lightTarget);
  const encode = (current: Frame) => {
    current.pass({ target: lightTarget, clear: [0, 0, 0, 0] }, (pass) => pass.draw(scene.light));
    current.pass({ target: wallTarget }, (pass) => pass.draw(scene.wall));
    current.pass({ target: output }, (pass) => {
      pass.draw(scene.present);
      if (scene.controls.view === "glass") pass.draw(scene.glass);
    });
  };
  if (currentFrame) encode(currentFrame);
  else frame(scene.gpu, encode);
}

function bind(scene: PrismScene, wallTarget: Target, lightTarget: Target): void {
  const values = sceneUniforms(scene);
  scene.light.set({ scene: values });
  scene.wall.set({ scene: values, lightTexture: lightTarget });
  scene.present.set({ sceneTexture: wallTarget });
  scene.glass.set({
    params: glassUniforms(scene),
    sceneTexture: wallTarget,
    sceneSampler: scene.sceneSampler,
  });
}

function destroyTarget(value: Target | undefined): void {
  (value as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
}

export function destroyScene(scene: PrismScene): void {
  destroyTarget(scene.lightTarget);
  destroyTarget(scene.wallTarget);
  scene.lightTarget = undefined;
  scene.wallTarget = undefined;
  scene.lightBuffer.destroy();
  scene.prism.destroy();
}
