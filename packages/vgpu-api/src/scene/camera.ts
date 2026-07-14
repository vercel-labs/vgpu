import { degToRad, orthographicCamera as renderOrthographicCamera, perspectiveCamera as renderPerspectiveCamera, type Camera as RenderCamera, type Vec3 } from "./geometry-src/index.ts";

export type CameraVec3 = readonly [number, number, number] | Float32Array;

export interface SceneCamera {
  readonly viewProjection: Float32Array;
  readonly viewProjectionMatrix: Float32Array;
  readonly position: Float32Array;
}

export type Camera = SceneCamera;

export interface PerspectiveCameraOptions {
  readonly fov: number;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
  readonly position: CameraVec3;
  readonly target: CameraVec3;
  readonly up?: CameraVec3;
}

export interface OrthographicCameraOptions {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
  readonly near?: number;
  readonly far?: number;
  readonly position: CameraVec3;
  readonly target: CameraVec3;
  readonly up?: CameraVec3;
}

/** Creates a view/projection camera using degrees for the public scene API. */
export function perspectiveCamera(options: PerspectiveCameraOptions): SceneCamera {
  return sceneCamera(renderPerspectiveCamera({
    fovYRadians: degToRad(options.fov),
    aspect: options.aspect ?? 1,
    near: options.near ?? 0.1,
    far: options.far ?? 100,
    position: vec3(options.position),
    target: vec3(options.target),
    up: options.up ? vec3(options.up) : undefined,
  }));
}

/** Creates an orthographic view/projection camera for shaders expecting `viewProjection`. */
export function orthographicCamera(options: OrthographicCameraOptions): SceneCamera {
  return sceneCamera(renderOrthographicCamera({
    left: options.left,
    right: options.right,
    bottom: options.bottom,
    top: options.top,
    near: options.near ?? 0.1,
    far: options.far ?? 100,
    position: vec3(options.position),
    target: vec3(options.target),
    up: options.up ? vec3(options.up) : undefined,
  }));
}

function sceneCamera(camera: RenderCamera): SceneCamera {
  const viewProjection = new Float32Array(camera.viewProjectionMatrix);
  return Object.freeze({
    viewProjection,
    viewProjectionMatrix: viewProjection,
    position: new Float32Array(camera.position),
  });
}

function vec3(value: CameraVec3): Vec3 {
  return new Float32Array(value) as Vec3;
}
