import { draw, effect, geometry, sampler, target, type Draw, type Effect, type Frame, type Gpu, type Target } from 'vgpu';
import { box, cylinder, sphere, torus, type CameraMatrices } from 'vgpu/scene';
import { instanceGeometry, type InstanceGeometry } from 'vgpu/scene/gpu';

import backdropWgsl from './backdrop.wgsl';
import { KEY_DIRECTION, updateCamera, type Camera } from './camera';
import presentWgsl from './present.wgsl';
import { MESHES, PLINTH, type Collections, type MeshName, type Mobile } from './scene';
import sculptureWgsl from './sculpture.wgsl';
import shadowWgsl from './shadow.wgsl';

/** GPU half of the example, shared by the live renderer and the thumbnail. Nothing here touches the DOM. */

const SHADOW_SIZE = 2048;
const SCENE_FORMAT: GPUTextureFormat = 'rgba8unorm';

export interface Pipeline {
  readonly bridges: Record<MeshName, InstanceGeometry>;
  readonly lit: Record<MeshName, Draw>;
  readonly casters: Record<MeshName, Draw>;
  readonly backdrop: Draw;
  readonly present: Effect;
  readonly shadow: Target;
  readonly scene: Target;
  /** Instance counts from the latest publish(). */
  readonly counts: Record<MeshName, number>;
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
  readonly exposure?: number;
}

function sceneTarget(gpu: Gpu, size: readonly [number, number]): Target {
  return target(gpu, { size, format: SCENE_FORMAT, depth: true, msaa: true, label: 'kinetic-sculpture.scene' });
}

export async function createPipeline(
  gpu: Gpu,
  collections: Collections,
  size: readonly [number, number],
  outputFormat: GPUTextureFormat,
): Promise<Pipeline> {
  // Unit meshes, reused by every instance; node scales give each part its size.
  const meshes = {
    box: geometry(gpu, box({ size: 1 })),
    cylinder: geometry(gpu, cylinder({ radius: 1, height: 1, radialSegments: 28 })),
    sphere: geometry(gpu, sphere({ radius: 1, widthSegments: 40, heightSegments: 22 })),
    torus: geometry(gpu, torus({ radius: 1, tube: 0.075, radialSegments: 14, tubularSegments: 72 })),
  };
  const bridges = Object.fromEntries(
    MESHES.map((mesh) => [mesh, instanceGeometry(gpu, collections[mesh], { mesh: meshes[mesh] })]),
  ) as Record<MeshName, InstanceGeometry>;

  const shadow = target(gpu, {
    size: [SHADOW_SIZE, SHADOW_SIZE],
    format: 'r8unorm',
    depth: 'depth32float',
    label: 'kinetic-sculpture.shadow',
  });
  const scene = sceneTarget(gpu, size);
  const shadowSampler = sampler(gpu, {
    compare: 'less-equal',
    minFilter: 'linear',
    magFilter: 'linear',
    addressModeU: 'clamp-to-edge',
    addressModeV: 'clamp-to-edge',
  });
  const sceneSampler = sampler(gpu, { minFilter: 'linear', magFilter: 'linear' });

  const lit = Object.fromEntries(
    MESHES.map((mesh) => [
      mesh,
      draw(gpu, {
        shader: sculptureWgsl,
        geometry: bridges[mesh].geometry,
        // Closed meshes: back faces are never visible.
        cull: 'back',
        label: `kinetic-sculpture.${mesh}`,
        set: { shadowMap: shadow, shadowSampler },
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
        label: `kinetic-sculpture.${mesh}-shadow`,
      }),
    ]),
  ) as Record<MeshName, Draw>;
  const backdrop = draw(gpu, {
    shader: backdropWgsl,
    vertices: 3,
    depth: false,
    label: 'kinetic-sculpture.backdrop',
    set: { shadowMap: shadow, shadowSampler },
  });
  const present = effect(gpu, presentWgsl);
  present.set({ sceneColor: scene, sceneSampler });

  const pipeline: Pipeline = {
    bridges,
    lit,
    casters,
    backdrop,
    present,
    shadow,
    scene,
    counts: { box: 0, cylinder: 0, sphere: 0, torus: 0 },
  };
  await Promise.all([
    ...MESHES.map((mesh) => lit[mesh].compile(scene)),
    ...MESHES.map((mesh) => casters[mesh].compile(shadow)),
    backdrop.compile(scene),
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

/** Bound sources → instance worlds → GPU streams. Call once per frame, after posing the nodes. */
export function publish(collections: Collections, pipeline: Pipeline): void {
  for (const mesh of MESHES) {
    collections[mesh].syncWorlds();
    pipeline.counts[mesh] = pipeline.bridges[mesh].publish();
  }
}

/** One named uniform shared by every draw. */
export function setStudio(pipeline: Pipeline, view: StudioView): void {
  const v = view.camera.view;
  const studio = {
    viewProjection: view.camera.viewProjection,
    lightViewProjection: view.light.viewProjection,
    eye: [view.eye[0]!, view.eye[1]!, view.eye[2]!],
    tanHalfFov: Math.tan((view.fov * Math.PI) / 360),
    // Camera basis from the view matrix rows (the view is the inverse of the camera's world).
    right: [v[0]!, v[4]!, v[8]!],
    aspect: view.aspect,
    up: [v[1]!, v[5]!, v[9]!],
    exposure: view.exposure ?? 1.15,
    forward: [-v[2]!, -v[6]!, -v[10]!],
    shadowTexel: view.shadowTexel,
    keyDirection: KEY_DIRECTION,
    plinthTop: PLINTH.height,
    plinthHalf: [PLINTH.width / 2, PLINTH.depth / 2],
    pad: [0, 0],
  };
  for (const mesh of MESHES) {
    pipeline.lit[mesh].set({ studio });
    pipeline.casters[mesh].set({ studio });
  }
  pipeline.backdrop.set({ studio });
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

/** One frame of the sculpture: camera, instance streams, uniforms and passes, for the live page and the thumbnail. */
export function renderSculpture(
  currentFrame: Frame,
  pipeline: Pipeline,
  collections: Collections,
  scene: { readonly mobile: Mobile; readonly camera: Camera; readonly light: CameraMatrices },
  output: Target,
  /** Camera smoothing step in seconds; 0 snaps. */
  dt: number,
): void {
  const { mobile, camera, light } = scene;
  const aspect = output.size[0] / output.size[1];
  const view = updateCamera(camera, mobile, aspect, dt);
  publish(collections, pipeline);
  setStudio(pipeline, {
    camera: view,
    eye: camera.pose.position,
    fov: camera.lens.fov,
    aspect,
    light,
    // lightMatrices spans 2 × 1.12 radii across the map.
    shadowTexel: (2.24 * mobile.radius) / SHADOW_SIZE,
  });
  encode(currentFrame, pipeline, output);
}
