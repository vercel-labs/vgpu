import { draw, effect, geometry, sampler, target, uniforms, type Draw, type Effect, type Frame, type Gpu, type SharedUniforms, type Target } from 'vgpu';
import type { CameraMatrices } from 'vgpu/scene';
import { instanceGeometry, type InstanceGeometry } from 'vgpu/scene/gpu';

import backdropWgsl from './backdrop.wgsl';
import { KEY_DIRECTION } from './camera';
import marblesWgsl from './marbles.wgsl';
import presentWgsl from './present.wgsl';
import { MESHES, RECIPES, type MeshName, type Scene } from './scene';
import shadowWgsl from './shadow.wgsl';
import solidsWgsl from './solids.wgsl';

/** GPU half of the example, shared by the live renderer and the thumbnail. Nothing here touches the DOM. */

export const SHADOW_MAP_SIZE = 2048;
const SCENE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export interface Pipeline {
  readonly bridges: Record<MeshName, InstanceGeometry>;
  readonly lit: Record<MeshName, Draw>;
  readonly casters: Record<MeshName, Draw>;
  readonly backdrop: Draw;
  readonly present: Effect;
  readonly shadow: Target;
  readonly scene: Target;
  readonly studio: SharedUniforms<StudioValues>;
  /** Instance counts from the latest publish(). */
  readonly counts: Record<MeshName, number>;
}

/** Field order and types match `Studio` in common.wgsl. */
interface StudioValues extends Record<string, unknown> {
  viewProjection: ArrayLike<number>;
  lightViewProjection: ArrayLike<number>;
  eye: number[];
  tanHalfFov: number;
  right: number[];
  aspect: number;
  up: number[];
  exposure: number;
  forward: number[];
  shadowTexel: number;
  keyDirection: readonly number[];
  time: number;
}

/** The camera and light inputs the studio uniform is built from. */
export interface StudioView {
  readonly camera: CameraMatrices;
  readonly eye: ArrayLike<number>;
  readonly fov: number;
  readonly aspect: number;
  readonly light: CameraMatrices;
  /** World-space width of one shadow texel. */
  readonly shadowTexel: number;
  readonly time: number;
}

const EXPOSURE = 1.1;

function studioValues(view: StudioView): StudioValues {
  const v = view.camera.view;
  return {
    viewProjection: view.camera.viewProjection,
    lightViewProjection: view.light.viewProjection,
    eye: [view.eye[0]!, view.eye[1]!, view.eye[2]!],
    tanHalfFov: Math.tan((view.fov * Math.PI) / 360),
    // Camera basis from the view matrix rows (the view is the inverse of the camera's world).
    right: [v[0]!, v[4]!, v[8]!],
    aspect: view.aspect,
    up: [v[1]!, v[5]!, v[9]!],
    exposure: EXPOSURE,
    forward: [-v[2]!, -v[6]!, -v[10]!],
    shadowTexel: view.shadowTexel,
    keyDirection: KEY_DIRECTION,
    time: view.time,
  };
}

export async function createPipeline(
  gpu: Gpu,
  scene: Scene,
  size: readonly [number, number],
  outputFormat: GPUTextureFormat,
  view: StudioView,
): Promise<Pipeline> {
  const bridges = Object.fromEntries(
    MESHES.map((mesh) => [
      mesh,
      instanceGeometry(gpu, scene.collections[mesh], { mesh: geometry(gpu, RECIPES[mesh]()) }),
    ]),
  ) as Record<MeshName, InstanceGeometry>;

  const shadow = target(gpu, {
    size: [SHADOW_MAP_SIZE, SHADOW_MAP_SIZE],
    format: 'r8unorm',
    depth: 'depth32float',
    label: 'marble-machine.shadow',
  });
  const sceneColor = target(gpu, { size, format: SCENE_FORMAT, depth: true, msaa: true, label: 'marble-machine.scene' });
  const shadowSampler = sampler(gpu, {
    compare: 'less-equal',
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const sceneSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });
  // One named uniform, written once per frame and bound by every pass.
  const studio = uniforms(gpu, studioValues(view));

  const lit = Object.fromEntries(
    MESHES.map((mesh) => [
      mesh,
      draw(gpu, {
        shader: mesh === 'marbles' ? marblesWgsl : solidsWgsl,
        geometry: bridges[mesh].geometry,
        // Closed meshes: back faces are never visible.
        cull: 'back',
        label: `marble-machine.${mesh}`,
        set: { studio, shadowMap: shadow, shadowSampler },
      }),
    ]),
  ) as Record<MeshName, Draw>;
  const casters = Object.fromEntries(
    MESHES.map((mesh) => [
      mesh,
      draw(gpu, {
        shader: shadowWgsl,
        geometry: bridges[mesh].geometry,
        depth: { write: true, compare: 'less-equal', bias: 2, biasSlopeScale: 2.5 },
        label: `marble-machine.${mesh}-shadow`,
        set: { studio },
      }),
    ]),
  ) as Record<MeshName, Draw>;
  const backdrop = draw(gpu, {
    shader: backdropWgsl,
    vertices: 3,
    depth: false,
    label: 'marble-machine.backdrop',
    set: { studio },
  });
  const present = effect(gpu, presentWgsl);
  present.set({ sceneColor, sceneSampler });

  const pipeline: Pipeline = {
    bridges,
    lit,
    casters,
    backdrop,
    present,
    shadow,
    scene: sceneColor,
    studio,
    counts: { parts: 0, trims: 0, marbles: 0 },
  };
  await Promise.all([
    ...MESHES.map((mesh) => lit[mesh].compile(sceneColor)),
    ...MESHES.map((mesh) => casters[mesh].compile(shadow)),
    backdrop.compile(sceneColor),
    present.compile({ colors: [outputFormat] }),
  ]);
  return pipeline;
}

/** Matches the multisampled scene target to the output size. */
export function resizePipeline(pipeline: Pipeline, size: readonly [number, number]): void {
  if (pipeline.scene.size[0] === size[0] && pipeline.scene.size[1] === size[1]) return;
  pipeline.scene.resize(size);
  pipeline.present.set({ sceneColor: pipeline.scene });
}

/** Instance worlds → GPU streams. Call once per frame, after syncing the scene. */
export function publish(pipeline: Pipeline): void {
  for (const mesh of MESHES) pipeline.counts[mesh] = pipeline.bridges[mesh].publish();
}

export function setStudio(pipeline: Pipeline, view: StudioView): void {
  pipeline.studio.set(studioValues(view));
}

/** Shadow pass → lit scene (backdrop first, it writes no depth) → present. */
export function encode(currentFrame: Frame, pipeline: Pipeline, output: Target): void {
  currentFrame.pass({ target: pipeline.shadow, clear: [0, 0, 0, 0] }, (pass) => {
    for (const mesh of MESHES) {
      const count = pipeline.counts[mesh];
      if (count > 0) pass.draw(pipeline.casters[mesh], { instances: count });
    }
  });
  currentFrame.pass({ target: pipeline.scene, clear: [0, 0, 0, 1] }, (pass) => {
    pass.draw(pipeline.backdrop);
    for (const mesh of MESHES) {
      const count = pipeline.counts[mesh];
      if (count > 0) pass.draw(pipeline.lit[mesh], { instances: count });
    }
  });
  currentFrame.pass({ target: output }, (pass) => pass.draw(pipeline.present));
}
