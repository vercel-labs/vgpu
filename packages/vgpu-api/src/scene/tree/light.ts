import { sceneValueError } from "./errors.ts";
import { SceneNode, type NodeOptions, type NodeTransformValues, type Vec3Like } from "./node.ts";

export interface DirectionalLightOptions extends NodeOptions {
  /** World-space direction the light travels toward. Defaults to `[0, -1, 0]`. */
  readonly direction?: Vec3Like;
  /** Linear RGB color. Defaults to white. */
  readonly color?: Vec3Like;
  readonly intensity?: number;
}

export interface DirectionalLightValues extends NodeTransformValues {
  readonly direction?: Vec3Like;
  readonly color?: Vec3Like;
  readonly intensity?: number;
}

export interface AmbientLightOptions extends NodeOptions {
  readonly color?: Vec3Like;
  readonly intensity?: number;
}

export interface AmbientLightValues extends NodeTransformValues {
  readonly color?: Vec3Like;
  readonly intensity?: number;
}

/** Directional (sun-style) light node. Direction is explicit, not transform-derived. */
export class DirectionalLight extends SceneNode {
  #direction = new Float32Array([0, -1, 0]);
  #color = new Float32Array([1, 1, 1]);
  #intensity = 1;

  constructor(options: DirectionalLightOptions = {}) {
    // Validate before super(): SceneNode's constructor reparents `options.children`, so a
    // throw after it would strand them on a light nobody can reach.
    validateLightOptions(`${options.label ?? "directional-light"}.set`, options);
    super("directional-light", options);
    this.#apply(options);
  }

  override set(values: DirectionalLightValues): this {
    super.set(values);
    this.#apply(values);
    return this;
  }

  /** World-space travel direction. Stable array identity; mutate via `set()`. */
  get direction(): Float32Array {
    return this.#direction;
  }

  get color(): Float32Array {
    return this.#color;
  }

  get intensity(): number {
    return this.#intensity;
  }

  #apply(values: DirectionalLightValues): void {
    const where = `${this.label ?? this.kind}.set`;
    if (values.direction !== undefined) writeVec3(this.#direction, values.direction, "direction", where);
    if (values.color !== undefined) writeVec3(this.#color, values.color, "color", where);
    if (values.intensity !== undefined) this.#intensity = requireNonNegative(where, values.intensity);
  }
}

/** Ambient fill light node applied uniformly to lit materials. */
export class AmbientLight extends SceneNode {
  #color = new Float32Array([1, 1, 1]);
  #intensity = 1;

  constructor(options: AmbientLightOptions = {}) {
    // Validate before super(): see DirectionalLight.
    validateLightOptions(`${options.label ?? "ambient-light"}.set`, options);
    super("ambient-light", options);
    this.#apply(options);
  }

  override set(values: AmbientLightValues): this {
    super.set(values);
    this.#apply(values);
    return this;
  }

  get color(): Float32Array {
    return this.#color;
  }

  get intensity(): number {
    return this.#intensity;
  }

  #apply(values: AmbientLightValues): void {
    const where = `${this.label ?? this.kind}.set`;
    if (values.color !== undefined) writeVec3(this.#color, values.color, "color", where);
    if (values.intensity !== undefined) this.#intensity = requireNonNegative(where, values.intensity);
  }
}

export function directionalLight(options: DirectionalLightOptions = {}): DirectionalLight {
  return new DirectionalLight(options);
}

export function ambientLight(options: AmbientLightOptions = {}): AmbientLight {
  return new AmbientLight(options);
}

function writeVec3(out: Float32Array, value: Vec3Like, name: string, where: string): void {
  if (value.length !== 3) throw sceneValueError(where, name, "an array of 3 numbers");
  out[0] = value[0]!;
  out[1] = value[1]!;
  out[2] = value[2]!;
}

/**
 * Raw-option check runnable before `super()` (no `this`). `#apply()` re-runs the same
 * checks after construction, so the two paths cannot drift.
 */
function validateLightOptions(where: string, options: DirectionalLightOptions | AmbientLightOptions): void {
  const direction = (options as DirectionalLightOptions).direction;
  if (direction !== undefined && direction.length !== 3) {
    throw sceneValueError(where, "direction", "an array of 3 numbers");
  }
  if (options.color !== undefined && options.color.length !== 3) {
    throw sceneValueError(where, "color", "an array of 3 numbers");
  }
  if (options.intensity !== undefined) requireNonNegative(where, options.intensity);
}

function requireNonNegative(where: string, value: number): number {
  if (!(value >= 0)) throw sceneValueError(where, "intensity", "a number greater than or equal to 0");
  return value;
}
