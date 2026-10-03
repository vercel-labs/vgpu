// Camera views per preset, follow framing and the pointer ray. Pure: no DOM, no GPU.

import { quat, vec3, type Quat, type Vec3 } from "math";
import type { Lens, OrbitRig, OrbitRigOptions, Pose } from "vgpu/scene";

import type { PresetName } from "./colony";
import type { Robot } from "./robot";

/** Where each preset puts the camera. Close-up follows robot 0 from just above its shoulder. */
export const VIEWS: Readonly<Record<PresetName, Required<Pick<OrbitRigOptions, "yaw" | "pitch" | "distance">> & { readonly target: Vec3 }>> = {
  "close-up": { target: [0, 0.25, 0], yaw: 0.85, pitch: 0.38, distance: 3.1 },
  colony: { target: [0, 0, 0.6], yaw: 0.62, pitch: 0.62, distance: 14.5 },
  stress: { target: [0, 0, 0], yaw: 0.62, pitch: 0.72, distance: 19 },
};

/** Extra downward pitch at aspect 0 (portrait frames see more ground and less backdrop). */
const PORTRAIT_PITCH = 0.6;

/**
 * Point the rig goal at a preset view for a frame of `aspect` (width / height); the smoothed rig
 * glides there. Below aspect 1 the camera tilts down so a phone's tall frame shows the tile, not
 * the backdrop above it.
 */
export function applyView(goal: OrbitRig, preset: PresetName, aspect: number): void {
  const view = VIEWS[preset];
  goal.target.set(view.target);
  goal.pan.fill(0);
  goal.yaw = view.yaw;
  goal.pitch = Math.min(1.3, view.pitch + PORTRAIT_PITCH * Math.max(0, 1 - (Number.isFinite(aspect) ? aspect : 1)));
  goal.distance = view.distance;
}

const FOLLOW_HEIGHT = 0.18;

/** Follow mode: the goal target tracks a robot's body, keeping the user's yaw, pitch and zoom. */
export function followRobot(goal: OrbitRig, robot: Robot): void {
  goal.target[0] = robot.position[0];
  goal.target[1] = robot.position[1] + FOLLOW_HEIGHT - 0.3;
  goal.target[2] = robot.position[2];
  goal.pan.fill(0);
}

/** Narrowest aspect that keeps the base vertical fov; taller frames widen it to hold the width. */
const FIT_ASPECT = 1.0;
const MAX_FOV = 70;

/**
 * Portrait frames (phones) would crop the tile's sides at a fixed vertical fov. Below
 * FIT_ASPECT this widens the vertical fov so the horizontal fov matches FIT_ASPECT's.
 */
export function fitLens(base: Lens, aspect: number, out: Lens): Lens {
  out.near = base.near;
  out.far = base.far;
  if (aspect >= FIT_ASPECT) {
    out.fov = base.fov;
    return out;
  }
  const halfTan = Math.tan((base.fov * Math.PI) / 360) * (FIT_ASPECT / aspect);
  out.fov = Math.min(MAX_FOV, (Math.atan(halfTan) * 360) / Math.PI);
  return out;
}

const local: Vec3 = [0, 0, 0];
const rotation: Quat = [0, 0, 0, 1];

/**
 * World ray through a canvas point given in normalized device coordinates (x right, y up, both in
 * [-1, 1]) for a perspective camera at `pose` looking down its local -Z.
 */
export function cameraRay(pose: Pose, lens: Lens, aspect: number, ndcX: number, ndcY: number, origin: Vec3, direction: Vec3): void {
  const tan = Math.tan((lens.fov * Math.PI) / 360);
  vec3.set(local, ndcX * tan * aspect, ndcY * tan, -1);
  quat.set(rotation, pose.quaternion[0]!, pose.quaternion[1]!, pose.quaternion[2]!, pose.quaternion[3]!);
  vec3.transformQuat(direction, local, rotation);
  vec3.normalize(direction, direction);
  vec3.set(origin, pose.position[0]!, pose.position[1]!, pose.position[2]!);
}
