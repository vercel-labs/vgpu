import { sceneValueError } from "./errors.ts";
import type { Vec3Like } from "./node.ts";

export type SceneMaterialKind = "unlit" | "normal" | "lambert" | "shader";

/** Blend preset shared with `DrawOptions.blend`. */
export type MaterialBlend = "alpha" | "additive" | "premultiplied";

/**
 * Pure material descriptor consumed by the scene renderer. Holds shading parameters only —
 * no GPU resources; pipelines are compiled when a tree is bound with `gpu.scene()`.
 */
export abstract class SceneMaterial {
  /**
   * Set by the base constructor (not by a subclass field) so it is already readable while
   * a subclass constructor validates its options — subclass fields are installed only
   * after `super()` returns, which used to make validation errors report `undefined.set`.
   */
  readonly kind: SceneMaterialKind;
  label: string | undefined;
  blend: MaterialBlend | undefined;

  constructor(kind: SceneMaterialKind) {
    this.kind = kind;
  }
}

export interface ColorMaterialOptions {
  /** Linear RGB color; pass `srgb("#…")` for hex input. Defaults to white. */
  readonly color?: Vec3Like;
  readonly opacity?: number;
  readonly blend?: MaterialBlend;
  readonly label?: string;
}

export interface ColorMaterialValues {
  readonly color?: Vec3Like;
  readonly opacity?: number;
}

abstract class ColorMaterial extends SceneMaterial {
  #color = new Float32Array([1, 1, 1]);
  #opacity = 1;

  constructor(kind: SceneMaterialKind, options: ColorMaterialOptions = {}) {
    super(kind);
    this.label = options.label;
    this.blend = options.blend;
    this.#apply(options);
  }

  set(values: ColorMaterialValues): this {
    this.#apply(values);
    return this;
  }

  /** Linear RGB color. Stable array identity; mutate via `set()`. */
  get color(): Float32Array {
    return this.#color;
  }

  get opacity(): number {
    return this.#opacity;
  }

  #apply(values: ColorMaterialValues): void {
    const where = `${this.label ?? this.kind}.set`;
    if (values.color !== undefined) {
      if (values.color.length !== 3) throw sceneValueError(where, "color", "an array of 3 linear RGB components");
      this.#color[0] = values.color[0]!;
      this.#color[1] = values.color[1]!;
      this.#color[2] = values.color[2]!;
    }
    if (values.opacity !== undefined) {
      if (!(values.opacity >= 0 && values.opacity <= 1)) throw sceneValueError(where, "opacity", "a number between 0 and 1");
      this.#opacity = values.opacity;
    }
  }
}

/** Flat-color material; renders without lights. */
export class UnlitMaterial extends ColorMaterial {
  // `declare` redeclares the base field's type only (no own property, no init order issue).
  declare readonly kind: "unlit";

  constructor(options: ColorMaterialOptions = {}) {
    super("unlit", options);
  }
}

/** N·L diffuse material lit by scene lights (uses `@vgpu/wgsl-std/light` lambert). */
export class LambertMaterial extends ColorMaterial {
  declare readonly kind: "lambert";

  constructor(options: ColorMaterialOptions = {}) {
    super("lambert", options);
  }
}

/** Debug material that shades world-space normals; needs no lights or parameters. */
export class NormalMaterial extends SceneMaterial {
  declare readonly kind: "normal";

  constructor() {
    super("normal");
  }
}

export interface ShaderMaterialOptions {
  /** Initial binding values keyed by WGSL variable name, like `draw.set()`. */
  readonly set?: Record<string, unknown>;
  readonly blend?: MaterialBlend;
  readonly label?: string;
}

/**
 * Custom material: a WGSL fragment stage compiled against the scene renderer's vertex
 * contract. Scene globals live in `@group(0)` (renderer-owned); material bindings start
 * at `@group(1)`.
 */
export class ShaderMaterial extends SceneMaterial {
  declare readonly kind: "shader";
  readonly source: string;
  #values: Record<string, unknown>;

  constructor(source: string, options: ShaderMaterialOptions = {}) {
    super("shader");
    this.source = source;
    this.label = options.label;
    this.blend = options.blend;
    this.#values = { ...options.set };
  }

  /** Merges binding values per top-level key; the renderer forwards them to `draw.set()`. */
  set(values: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(values)) {
      const previous = this.#values[key];
      this.#values[key] = isPlainObject(previous) && isPlainObject(value)
        ? { ...previous, ...value }
        : value;
    }
    return this;
  }

  get values(): Readonly<Record<string, unknown>> {
    return this.#values;
  }
}

export function unlitMaterial(options: ColorMaterialOptions = {}): UnlitMaterial {
  return new UnlitMaterial(options);
}

export function lambertMaterial(options: ColorMaterialOptions = {}): LambertMaterial {
  return new LambertMaterial(options);
}

export function normalMaterial(): NormalMaterial {
  return new NormalMaterial();
}

export function shaderMaterial(source: string, options: ShaderMaterialOptions = {}): ShaderMaterial {
  return new ShaderMaterial(source, options);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !ArrayBuffer.isView(value) && !Array.isArray(value);
}
