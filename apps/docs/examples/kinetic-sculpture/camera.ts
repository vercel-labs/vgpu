import {
  group,
  orbit,
  orbitRig,
  orthographic,
  perspective,
  rigPose,
  smoothRig,
  viewMatrices,
  type CameraMatrices,
  type Lens,
  type OrbitRig,
  type Pose,
} from 'vgpu/scene';

/** The camera state this example owns: a goal rig the input writes and a smoothed rig it views. */
export interface Camera {
  readonly goal: OrbitRig;
  readonly current: OrbitRig;
  readonly lens: Lens;
  readonly pose: Pose;
  readonly projection: Float32Array;
  readonly matrices: CameraMatrices;
  /** Zoom multiplier on the fitted distance; < 1 is closer. */
  zoom: number;
}

export const DEFAULT_VIEW = { yaw: 0.42, pitch: 0.16, zoom: 1 } as const;
export const PITCH_LIMITS = { minPitch: -0.04, maxPitch: 0.85 } as const;
export const ZOOM_LIMITS = { min: 0.55, max: 1.7 } as const;
const LENS: Lens = { fov: 32, near: 0.1, far: 60 };
const SMOOTHING = { timeConstant: 0.12 } as const;

export function createCamera(): Camera {
  const initial = { yaw: DEFAULT_VIEW.yaw, pitch: DEFAULT_VIEW.pitch, distance: 8 };
  return {
    goal: orbitRig(initial),
    current: orbitRig(initial),
    lens: { ...LENS },
    pose: { position: new Float32Array(3), quaternion: new Float32Array(4) },
    projection: new Float32Array(16),
    matrices: { view: new Float32Array(16), viewProjection: new Float32Array(16) },
    zoom: DEFAULT_VIEW.zoom,
  };
}

/**
 * Distance at which a box of half extents [width, height] fills the frame for this aspect.
 * Whichever field of view is tighter decides, so portrait viewports back away; the extra
 * half-depth keeps parts that swing toward the camera inside the frame.
 */
export function fitDistance(extent: readonly [number, number], fovDegrees: number, aspect: number): number {
  const tanVertical = Math.tan((fovDegrees * Math.PI) / 360);
  const tanHorizontal = tanVertical * aspect;
  // Portrait frames would otherwise shrink the mobile to a strip; let the swinging tips crop a little.
  const width = extent[0] * (aspect < 1 ? 0.5 + 0.5 * aspect : 1);
  return Math.max(extent[1] / tanVertical, width / tanHorizontal) * 1.06 + width * 0.4;
}

export function orbitBy(camera: Camera, deltaYaw: number, deltaPitch: number): void {
  orbit(camera.goal, deltaYaw, deltaPitch, PITCH_LIMITS);
}

export function zoomBy(camera: Camera, factor: number): void {
  camera.zoom = Math.min(ZOOM_LIMITS.max, Math.max(ZOOM_LIMITS.min, camera.zoom * factor));
}

export function resetView(camera: Camera): void {
  camera.goal.yaw = DEFAULT_VIEW.yaw;
  camera.goal.pitch = DEFAULT_VIEW.pitch;
  camera.zoom = DEFAULT_VIEW.zoom;
}

/**
 * Aims the goal at the framed sphere, smooths toward it and writes the view matrices.
 * `dt` = 0 snaps (thumbnails and the first frame).
 */
export function updateCamera(
  camera: Camera,
  frame: { center: readonly number[]; extent: readonly [number, number] },
  aspect: number,
  dt: number,
): CameraMatrices {
  camera.goal.target.set(frame.center);
  camera.goal.distance = fitDistance(frame.extent, camera.lens.fov, aspect) * camera.zoom;
  if (dt <= 0) {
    camera.current.target.set(camera.goal.target);
    camera.current.pan.set(camera.goal.pan);
    camera.current.yaw = camera.goal.yaw;
    camera.current.pitch = camera.goal.pitch;
    camera.current.distance = camera.goal.distance;
  } else {
    smoothRig(camera.current, camera.goal, Math.min(dt, 0.1), SMOOTHING);
  }
  perspective(camera.lens, aspect, camera.projection);
  viewMatrices(rigPose(camera.current, camera.pose), camera.projection, camera.matrices);
  return camera.matrices;
}

/** Direction toward the key light (world space, normalized). It stays fixed while the camera orbits. */
export const KEY_DIRECTION = normalize([-0.52, 1, 0.42]);

/**
 * The key light's orthographic view-projection, covering a sphere of `radius` around `center`
 * plus the floor in front of the plinth.
 */
export function lightMatrices(center: readonly number[], radius: number, out: CameraMatrices): CameraMatrices {
  const distance = radius * 3;
  const eye = center.map((value, axis) => value + KEY_DIRECTION[axis]! * distance);
  const light = group({ position: eye }).lookAt(center);
  const pose: Pose = { position: new Float32Array(light.position), quaternion: new Float32Array(light.quaternion) };
  const extent = radius * 1.12;
  const projection = orthographic(
    { left: -extent, right: extent, bottom: -extent, top: extent, near: distance - radius * 2, far: distance + radius * 2.5 },
    new Float32Array(16),
  );
  viewMatrices(pose, projection, out);
  return out;
}

function normalize(vector: readonly [number, number, number]): readonly [number, number, number] {
  const length = Math.hypot(...vector);
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}
