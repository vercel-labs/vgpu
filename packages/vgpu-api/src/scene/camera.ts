import { orthographic, perspective } from "./geometry-src/camera-math.ts";
import { degToRad } from "./geometry-src/index.ts";
import { sceneValueError } from "./tree/errors.ts";
import { identityMat4, invertAffineMat4, multiplyMat4, type Mat4 } from "./tree/math.ts";
import { SceneNode, type NodeOptions, type NodeTransformValues } from "./tree/node.ts";

export type CameraVec3 = readonly [number, number, number] | Float32Array;

/**
 * Common contract of scene cameras. Matrices are stable `Float32Array` identities updated
 * in place, so a binding set once stays fresh across frames.
 */
export interface SceneCamera {
  /** Column-major projection × view matrix. Bind this to your WGSL uniforms. */
  readonly viewProjection: Float32Array;
  /** Alias of `viewProjection`, kept for naming continuity. */
  readonly viewProjectionMatrix: Float32Array;
  /** Local position (world position for unparented cameras). Mutate via `set()`. */
  readonly position: Float32Array;
  readonly view: Float32Array;
  readonly projection: Float32Array;
  readonly worldPosition: Float32Array;
}

export type Camera = SceneCamera;

interface CameraSharedOptions extends NodeOptions {
  readonly near?: number;
  readonly far?: number;
  /** World-space point the camera looks at initially. Reorient later with `lookAt()`. */
  readonly target?: CameraVec3;
  readonly up?: CameraVec3;
}

export interface PerspectiveCameraOptions extends CameraSharedOptions {
  /** Vertical field of view in degrees. */
  readonly fov: number;
  readonly aspect?: number;
}

export interface OrthographicCameraOptions extends CameraSharedOptions {
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly top: number;
}

export interface PerspectiveCameraValues extends NodeTransformValues {
  readonly fov?: number;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface OrthographicCameraValues extends NodeTransformValues {
  readonly left?: number;
  readonly right?: number;
  readonly bottom?: number;
  readonly top?: number;
  readonly near?: number;
  readonly far?: number;
}

abstract class CameraNode extends SceneNode implements SceneCamera {
  #projection = identityMat4(new Float32Array(16));
  #view = identityMat4(new Float32Array(16));
  #viewProjection = identityMat4(new Float32Array(16));
  protected _projectionDirty = true;
  #viewWorldVersion = -1;
  #viewProjectionStale = true;

  get projection(): Mat4 {
    if (this._projectionDirty) {
      this._updateProjection(this.#projection);
      this._projectionDirty = false;
      this.#viewProjectionStale = true;
    }
    return this.#projection;
  }

  get view(): Mat4 {
    this.#syncView();
    return this.#view;
  }

  get viewProjection(): Mat4 {
    const projection = this.projection;
    this.#syncView();
    if (this.#viewProjectionStale) {
      multiplyMat4(this.#viewProjection, projection, this.#view);
      this.#viewProjectionStale = false;
    }
    return this.#viewProjection;
  }

  get viewProjectionMatrix(): Mat4 {
    return this.viewProjection;
  }

  #syncView(): void {
    const world = this.worldMatrix;
    if (this.#viewWorldVersion !== this._worldVersion) {
      invertAffineMat4(this.#view, world);
      this.#viewWorldVersion = this._worldVersion;
      this.#viewProjectionStale = true;
    }
  }

  protected abstract _updateProjection(out: Mat4): void;
}

/** Perspective projection camera node. `fov` is in degrees for the public scene API. */
export class PerspectiveCamera extends CameraNode {
  #fov: number;
  #aspect: number | undefined;
  #near: number;
  #far: number;

  constructor(options: PerspectiveCameraOptions) {
    // Validate before super(): SceneNode's constructor reparents `options.children`, so a
    // throw after it would strand them on a camera nobody can reach.
    validateFov("perspectiveCamera", options.fov);
    if (options.aspect !== undefined) validateAspect("perspectiveCamera", options.aspect);
    validateRange("perspectiveCamera", options.near ?? 0.1, options.far ?? 100);
    validateInitialLookAt("perspectiveCamera", options.target, options.up);
    super("perspective-camera", options);
    this.#fov = options.fov;
    this.#aspect = options.aspect;
    this.#near = options.near ?? 0.1;
    this.#far = options.far ?? 100;
    if (options.target) this.lookAt(options.target, options.up);
  }

  override set(values: PerspectiveCameraValues): this {
    super.set(values);
    const where = `${this.label ?? this.kind}.set`;
    if (values.fov !== undefined) {
      validateFov(where, values.fov);
      this.#fov = values.fov;
      this._projectionDirty = true;
    }
    if (values.aspect !== undefined) {
      validateAspect(where, values.aspect);
      this.#aspect = values.aspect;
      this._projectionDirty = true;
    }
    if (values.near !== undefined || values.far !== undefined) {
      const near = values.near ?? this.#near;
      const far = values.far ?? this.#far;
      validateRange(where, near, far);
      this.#near = near;
      this.#far = far;
      this._projectionDirty = true;
    }
    return this;
  }

  get fov(): number {
    return this.#fov;
  }

  /** Resolved aspect ratio; defaults to 1 until set explicitly. */
  get aspect(): number {
    return this.#aspect ?? 1;
  }

  get near(): number {
    return this.#near;
  }

  get far(): number {
    return this.#far;
  }

  protected _updateProjection(out: Mat4): void {
    out.set(perspective(degToRad(this.#fov), this.#aspect ?? 1, this.#near, this.#far));
  }
}

/** Orthographic projection camera node. */
export class OrthographicCamera extends CameraNode {
  #left: number;
  #right: number;
  #bottom: number;
  #top: number;
  #near: number;
  #far: number;

  constructor(options: OrthographicCameraOptions) {
    // Validate before super() so a rejected option bag cannot strand `options.children`.
    validateExtent("orthographicCamera", "left", options.left, "right", options.right);
    validateExtent("orthographicCamera", "bottom", options.bottom, "top", options.top);
    validateRange("orthographicCamera", options.near ?? 0.1, options.far ?? 100);
    validateInitialLookAt("orthographicCamera", options.target, options.up);
    super("orthographic-camera", options);
    this.#left = options.left;
    this.#right = options.right;
    this.#bottom = options.bottom;
    this.#top = options.top;
    this.#near = options.near ?? 0.1;
    this.#far = options.far ?? 100;
    if (options.target) this.lookAt(options.target, options.up);
  }

  override set(values: OrthographicCameraValues): this {
    super.set(values);
    const where = `${this.label ?? this.kind}.set`;
    let projectionTouched = false;
    if (values.left !== undefined || values.right !== undefined) {
      validateExtent(where, "left", values.left ?? this.#left, "right", values.right ?? this.#right);
    }
    if (values.bottom !== undefined || values.top !== undefined) {
      validateExtent(where, "bottom", values.bottom ?? this.#bottom, "top", values.top ?? this.#top);
    }
    if (values.left !== undefined) { this.#left = values.left; projectionTouched = true; }
    if (values.right !== undefined) { this.#right = values.right; projectionTouched = true; }
    if (values.bottom !== undefined) { this.#bottom = values.bottom; projectionTouched = true; }
    if (values.top !== undefined) { this.#top = values.top; projectionTouched = true; }
    if (values.near !== undefined || values.far !== undefined) {
      const near = values.near ?? this.#near;
      const far = values.far ?? this.#far;
      validateRange(where, near, far);
      this.#near = near;
      this.#far = far;
      projectionTouched = true;
    }
    if (projectionTouched) this._projectionDirty = true;
    return this;
  }

  get left(): number { return this.#left; }
  get right(): number { return this.#right; }
  get bottom(): number { return this.#bottom; }
  get top(): number { return this.#top; }
  get near(): number { return this.#near; }
  get far(): number { return this.#far; }

  protected _updateProjection(out: Mat4): void {
    out.set(orthographic(this.#left, this.#right, this.#bottom, this.#top, this.#near, this.#far));
  }
}

/** Creates a stateful perspective camera node using degrees for the public scene API. */
export function perspectiveCamera(options: PerspectiveCameraOptions): PerspectiveCamera {
  return new PerspectiveCamera(options);
}

/** Creates a stateful orthographic camera node for shaders expecting `viewProjection`. */
export function orthographicCamera(options: OrthographicCameraOptions): OrthographicCamera {
  return new OrthographicCamera(options);
}

function validateInitialLookAt(where: string, target: CameraVec3 | undefined, up: CameraVec3 | undefined): void {
  if (target === undefined) return;
  if (target.length !== 3) throw sceneValueError(where, "target", "an array of 3 numbers");
  if (up !== undefined && up.length !== 3) throw sceneValueError(where, "up", "an array of 3 numbers");
}

function validateFov(where: string, fov: number): void {
  if (!(fov > 0 && fov < 180)) throw sceneValueError(where, "fov", "a field of view in degrees between 0 and 180 (exclusive)");
}

function validateRange(where: string, near: number, far: number): void {
  if (!(near > 0)) throw sceneValueError(where, "near", "a positive near plane distance");
  if (!(far > near)) throw sceneValueError(where, "far", "a far plane distance greater than `near`");
}

/** `canvas.width / canvas.height` is 0 or NaN during layout; that must not reach the matrix. */
function validateAspect(where: string, aspect: number): void {
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw sceneValueError(where, "aspect", "a positive, finite width/height ratio");
  }
}

function validateExtent(where: string, minName: string, min: number, maxName: string, max: number): void {
  if (!Number.isFinite(min)) throw sceneValueError(where, minName, "a finite number");
  if (!Number.isFinite(max)) throw sceneValueError(where, maxName, "a finite number");
  // Flipped ranges stay legal (a Y-flip is a real use case); empty ones divide by zero.
  if (min === max) throw sceneValueError(where, maxName, `a value different from \`${minName}\``);
}
