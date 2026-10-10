import {
  orbitRig,
  perspective,
  rigPose,
  smoothRig,
  viewMatrices,
  type Lens,
  type Mat4,
  type OrbitRig,
  type Pose,
} from "vgpu/scene";

export interface OceanCamera {
  readonly current: OrbitRig;
  readonly goal: OrbitRig;
  readonly lens: Lens;
  aspect: number;
  readonly pose: Pose;
  readonly projection: Mat4;
  readonly view: Mat4;
  readonly viewProjection: Mat4;
}

export function createOceanCamera(options: {
  readonly fov: number;
  readonly near: number;
  readonly far: number;
  readonly aspect: number;
  readonly position: ArrayLike<number>;
  readonly target: ArrayLike<number>;
}): OceanCamera {
  const x = options.position[0]! - options.target[0]!;
  const y = options.position[1]! - options.target[1]!;
  const z = options.position[2]! - options.target[2]!;
  const distance = Math.hypot(x, y, z);
  const goal = orbitRig({
    target: options.target,
    yaw: Math.atan2(x, z),
    pitch: Math.asin(y / distance),
    distance,
  });
  const current = orbitRig(goal);
  const camera: OceanCamera = {
    current,
    goal,
    lens: { fov: options.fov, near: options.near, far: options.far },
    aspect: options.aspect,
    pose: { position: new Float32Array(3), quaternion: new Float32Array(4) },
    projection: new Float32Array(16),
    view: new Float32Array(16),
    viewProjection: new Float32Array(16),
  };
  updateOceanCamera(camera, 0);
  return camera;
}

export function updateOceanCamera(camera: OceanCamera, deltaTime: number): OceanCamera {
  smoothRig(camera.current, camera.goal, deltaTime, { timeConstant: 0.12 });
  rigPose(camera.current, camera.pose);
  perspective(camera.lens, camera.aspect, camera.projection);
  viewMatrices(camera.pose, camera.projection, camera);
  return camera;
}

export function resizeOceanCamera(camera: OceanCamera, aspect: number): OceanCamera {
  camera.aspect = aspect;
  perspective(camera.lens, camera.aspect, camera.projection);
  viewMatrices(camera.pose, camera.projection, camera);
  return camera;
}
