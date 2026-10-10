// GPU side of the city, shared by the live renderer and the thumbnail. DOM-free.
//
// Per frame: city.sync() copies changed node worlds into the instance records, each bridge's
// publish() uploads changed rows and returns its count, and every pass that draws a bridge (sun
// shadow, color, outline, pick) receives that same count.

import { draw, effect, geometry, sampler, target, uniforms, type Draw, type Frame, type FramePass, type Gpu, type Target } from "vgpu";
import {
  box,
  cone,
  group,
  icosphere,
  orthographic,
  perspective,
  plane,
  rigPose,
  srgb,
  viewMatrices,
  worldPerPixel,
  type CameraMatrices,
  type Lens,
  type OrbitRig,
  type Pose,
} from "vgpu/scene";
import { instanceGeometry, type InstanceGeometry } from "vgpu/scene/gpu";

import { MESHES, type City } from "./city";
import cityShader from "./city.wgsl";
import groundShader from "./ground.wgsl";
import type { Mesh } from "./layout";
import pickShader from "./pick.wgsl";
import { PICK_FORMAT, PICK_SIZE, pickViewProjection, type PickPoint } from "./picking";
import presentShader from "./present.wgsl";
import shadowShader from "./shadow.wgsl";

export const LENS: Lens = { fov: 30, near: 2, far: 1000 };
/** Vertical lens shift (NDC): perspective makes the near half of the board taller, so frame it higher. */
const LENS_RISE = 0.12;
/** The isometric-ish home view (orbitRig options). */
export const HOME_VIEW = { target: [0, 3, 0], yaw: 0.78, pitch: 0.62, distance: 150 } as const;
export const SHADOW_SIZE = 2048;
/** Display-encoded (sRGB) fog and clear color: the scene target stores tone-mapped color. */
export const FOG_COLOR = [0.86, 0.83, 0.78] as const;
const SUN_DIRECTION = normalize([-0.34, 0.78, 0.52]);
const SUN_DISTANCE = 130;
const SUN_HALF_EXTENT = 58;
const OUTLINE_CSS_PX = 3;
/** Constant depth bias (units of 2^-24) on the selection mask and x-ray draws. */
const GHOST_BIAS = -16;

export interface Lighting {
  exposure: number;
  tiltShift: number;
}

export interface CityCamera {
  readonly pose: Pose;
  readonly projection: Float32Array;
  readonly matrices: CameraMatrices;
}

export type Counts = Record<Mesh, number>;

export interface RenderOptions {
  /** Pointer location (output device px) to render into the pick target this frame. */
  readonly pick?: PickPoint;
}

export interface CityPipeline {
  readonly camera: CityCamera;
  readonly lighting: Lighting;
  readonly pickTarget: Target;
  /** The worldRevision the sun shadow map was last rendered for. */
  readonly shadowRevision: number;
  resize(size: readonly [number, number], pixelRatio: number): void;
  /** `lensShift` moves the image center horizontally in NDC units (frames the city beside the panel). */
  updateCamera(rig: OrbitRig, lensShift?: number): void;
  /** Encodes every pass of one frame. Returns the published counts all passes drew with. */
  render(currentFrame: Frame, output: Target, options?: RenderOptions): Counts;
  /** Bytes of the last pick render; call after the frame that rendered it is done. */
  readPick(): Promise<Uint8Array>;
}

export function createPipeline(gpu: Gpu, city: City, size: readonly [number, number]): CityPipeline {
  const meshes: Record<Mesh, ReturnType<typeof geometry>> = {
    box: geometry(gpu, box({ size: 1 })),
    // A four-sided pyramid with its corners on the unit square: hip roofs and spires.
    roof: geometry(gpu, cone({ radius: Math.SQRT1_2, height: 1, radialSegments: 4, thetaStart: Math.PI / 4, shading: "flat" })),
    tree: geometry(gpu, icosphere({ radius: 0.5, subdivisions: 1, shading: "flat" })),
  };
  // One bridge per mesh: the collection's records become the instance stream of that mesh.
  const bridges = Object.fromEntries(
    MESHES.map((mesh) => [mesh, instanceGeometry(gpu, city.collections[mesh], { mesh: meshes[mesh] })])
  ) as Record<Mesh, InstanceGeometry>;

  const camera: CityCamera = {
    pose: { position: new Float32Array(3), quaternion: new Float32Array(4) },
    projection: new Float32Array(16),
    matrices: { view: new Float32Array(16), viewProjection: new Float32Array(16) },
  };
  const pickMatrix = new Float32Array(16);
  const outputSize: [number, number] = [size[0], size[1]];
  let pixelRatio = 1;

  const cameraValues = {
    viewProjection: camera.matrices.viewProjection,
    eye: camera.pose.position,
    pixelScale: 1,
  };
  const cameraUniforms = uniforms(gpu, cameraValues);
  const pickCameraUniforms = uniforms(gpu, { ...cameraValues, viewProjection: pickMatrix });

  const lightMatrix = sunViewProjection();
  const highlight = srgb("#ffb43c");
  const sceneUniforms = uniforms(gpu, {
    lightViewProjection: lightMatrix,
    sunDirection: SUN_DIRECTION,
    sunColor: [2.7, 2.38, 2.0],
    selectedBuilding: 0,
    skyColor: [0.5, 0.58, 0.7],
    selectedNeighborhood: 0,
    fogColor: FOG_COLOR,
    exposure: 0.95,
    highlightColor: highlight,
    outlineWidth: OUTLINE_CSS_PX,
  });

  const shadowTarget = target(gpu, {
    size: [SHADOW_SIZE, SHADOW_SIZE],
    format: "r8unorm",
    depth: "depth32float",
    label: "city.sun-shadow",
  });
  const sceneTarget = target(gpu, {
    size: outputSize,
    format: "rgba8unorm",
    // The stencil aspect marks where the selection is visible, so the x-ray skips its own parts.
    depth: "depth24plus-stencil8",
    msaa: true,
    label: "city.scene",
  });
  const pickTarget = target(gpu, {
    size: [PICK_SIZE, PICK_SIZE],
    format: PICK_FORMAT,
    depth: true,
    label: "city.pick",
  });
  const shadowSampler = sampler(gpu, {
    compare: "less-equal",
    minFilter: "linear",
    magFilter: "linear",
    addressModeU: "clamp-to-edge",
    addressModeV: "clamp-to-edge",
  });
  const linearSampler = sampler(gpu, { minFilter: "linear", magFilter: "linear" });
  const lit = { camera: cameraUniforms, scene: sceneUniforms, shadowMap: shadowTarget, shadowSampler };

  const perMesh = <T>(build: (mesh: Mesh) => T): Record<Mesh, T> =>
    Object.fromEntries(MESHES.map((mesh) => [mesh, build(mesh)])) as Record<Mesh, T>;

  const shadowDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: shadowShader,
      geometry: bridges[mesh].geometry,
      targets: [shadowTarget],
      writeMask: [],
      depth: { bias: 2, biasSlopeScale: 2.5 },
      set: { scene: sceneUniforms },
      label: `city.shadow.${mesh}`,
    })
  );
  const partDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: cityShader,
      geometry: bridges[mesh].geometry,
      targets: [sceneTarget],
      set: lit,
      label: `city.parts.${mesh}`,
    })
  );
  // Inverted hull: back faces of the selected building grown by a constant screen width.
  const outlineDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: cityShader,
      geometry: bridges[mesh].geometry,
      targets: [sceneTarget],
      entry: { vertex: "vs_outline", fragment: "fs_outline" },
      cull: "front",
      set: { camera: cameraUniforms, scene: sceneUniforms },
      label: `city.outline.${mesh}`,
    })
  );
  // X-ray, step 1: stencil 1 where the selection's front faces are the visible surface. The small
  // negative bias absorbs rounding between vs_main and vs_ghost, which compute the same position.
  const maskDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: cityShader,
      geometry: bridges[mesh].geometry,
      targets: [sceneTarget],
      entry: { vertex: "vs_ghost", fragment: "fs_ghost" },
      cull: "back",
      writeMask: [],
      depth: { write: false, compare: "less-equal", bias: GHOST_BIAS, biasSlopeScale: -1 },
      stencil: { front: { pass: "replace" }, ref: 1 },
      set: { camera: cameraUniforms, scene: sceneUniforms },
      label: `city.selection-mask.${mesh}`,
    })
  );
  // Step 2: tint the selection's front faces that another building hides (depth "greater" and
  // stencil unmarked). The same bias makes the two depth tests exact complements.
  const ghostDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: cityShader,
      geometry: bridges[mesh].geometry,
      targets: [sceneTarget],
      entry: { vertex: "vs_ghost", fragment: "fs_ghost" },
      cull: "back",
      depth: { write: false, compare: "greater", bias: GHOST_BIAS, biasSlopeScale: -1 },
      stencil: { front: { compare: "not-equal" }, ref: 1 },
      blend: "alpha",
      set: { camera: cameraUniforms, scene: sceneUniforms },
      label: `city.ghost.${mesh}`,
    })
  );
  const pickDraws = perMesh((mesh) =>
    draw(gpu, {
      shader: pickShader,
      geometry: bridges[mesh].geometry,
      targets: [pickTarget],
      set: { camera: pickCameraUniforms },
      label: `city.pick.${mesh}`,
    })
  );
  const ground = draw(gpu, {
    shader: groundShader,
    geometry: geometry(gpu, plane({ width: 1000, height: 1000 })),
    targets: [sceneTarget],
    set: lit,
    label: "city.ground",
  });
  const lighting: Lighting = { exposure: 0.95, tiltShift: 1 };
  const presentValues = { resolution: [outputSize[0], outputSize[1]], tiltShift: 1, focus: 0.54, pixelRatio: 1 };
  const present = effect(gpu, presentShader, {
    set: { present: presentValues, sceneColor: sceneTarget, linearSampler },
    label: "city.present",
  });

  let shadowRevision = -1;

  function drawEach(pass: FramePass, draws: Record<Mesh, Draw>, counts: Counts): void {
    for (const mesh of MESHES) {
      // A zero-instance draw is a no-op; skipping it keeps an empty collection valid.
      if (counts[mesh] > 0) pass.draw(draws[mesh], { instances: counts[mesh] });
    }
  }

  return {
    camera,
    lighting,
    pickTarget,
    get shadowRevision() {
      return shadowRevision;
    },
    resize(next, ratio) {
      outputSize[0] = next[0];
      outputSize[1] = next[1];
      pixelRatio = ratio;
      sceneTarget.resize(outputSize);
      presentValues.resolution = [next[0], next[1]];
      presentValues.pixelRatio = ratio;
      present.set({ present: presentValues });
    },
    updateCamera(rig, lensShift = 0) {
      rigPose(rig, camera.pose);
      perspective(LENS, outputSize[0] / outputSize[1], camera.projection);
      // Off-axis shift: clip.xy += shift * clip.w, with clip.w = -viewZ.
      camera.projection[8]! -= lensShift;
      camera.projection[9]! -= LENS_RISE;
      viewMatrices(camera.pose, camera.projection, camera.matrices);
      cameraValues.pixelScale = worldPerPixel(1, LENS, outputSize[1]);
      cameraUniforms.set(cameraValues);
    },
    render(currentFrame, output, options = {}) {
      city.sync();
      const counts = perMesh((mesh) => bridges[mesh].publish());
      sceneUniforms.set({
        selectedBuilding: city.selection.building,
        selectedNeighborhood: city.selection.neighborhood,
        exposure: lighting.exposure,
        outlineWidth: OUTLINE_CSS_PX * pixelRatio,
      });

      // The sun is fixed, so the shadow map only re-renders when synced worlds changed.
      if (shadowRevision !== city.worldRevision) {
        shadowRevision = city.worldRevision;
        currentFrame.pass({ target: shadowTarget, clear: [0, 0, 0, 0] }, (pass) => drawEach(pass, shadowDraws, counts));
      }
      currentFrame.pass({ target: sceneTarget, clear: [...FOG_COLOR, 1] }, (pass) => {
        pass.draw(ground);
        drawEach(pass, partDraws, counts);
        drawEach(pass, outlineDraws, counts);
        drawEach(pass, maskDraws, counts);
        drawEach(pass, ghostDraws, counts);
      });
      if (options.pick) {
        pickViewProjection(camera.matrices.viewProjection, options.pick, outputSize, pickMatrix);
        pickCameraUniforms.set({ viewProjection: pickMatrix, eye: camera.pose.position });
        currentFrame.pass({ target: pickTarget, clear: [0, 0, 0, 0] }, (pass) => drawEach(pass, pickDraws, counts));
      }
      if (presentValues.tiltShift !== lighting.tiltShift) {
        presentValues.tiltShift = lighting.tiltShift;
        present.set({ present: presentValues });
      }
      currentFrame.pass(output, present);
      return counts;
    },
    readPick() {
      return pickTarget.color.read({ mipLevel: 0, region: "all" });
    },
  };
}

/** Orthographic sun camera framing the whole board (plus lifted neighborhoods). */
function sunViewProjection(): Float32Array {
  const node = group({
    position: [SUN_DIRECTION[0] * SUN_DISTANCE, 6 + SUN_DIRECTION[1] * SUN_DISTANCE, SUN_DIRECTION[2] * SUN_DISTANCE],
  }).lookAt([0, 6, 0]);
  const pose: Pose = { position: new Float32Array(node.worldPosition), quaternion: new Float32Array(node.quaternion) };
  const projection = orthographic(
    {
      left: -SUN_HALF_EXTENT,
      right: SUN_HALF_EXTENT,
      bottom: -SUN_HALF_EXTENT,
      top: SUN_HALF_EXTENT,
      near: SUN_DISTANCE - 80,
      far: SUN_DISTANCE + 80,
    },
    new Float32Array(16)
  );
  const matrices: CameraMatrices = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
  viewMatrices(pose, projection, matrices);
  return matrices.viewProjection;
}

function normalize(vector: readonly [number, number, number]): [number, number, number] {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
