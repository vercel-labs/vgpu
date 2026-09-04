import * as THREE from "three/webgpu";
import { Fn, float, mix, texture, uv, vec2, vec3 } from "three/tsl";
import type { ShaderNodeObject } from "three/tsl";
import type { Node } from "three/webgpu";
import { tslExports } from "vgpu/three";
import lavaModule from "./lava.wgsl";

/** A TSL-wrapped node: the fluent object every three/tsl builder returns. */
type TslNode = ShaderNodeObject<Node>;

/**
 * Pre-baked field volumes for the lava material.
 *
 * The procedural fields in lava.wgsl are object-space 3D and, apart from a
 * slow domain drift and the breathing pulse, static — yet the live material
 * used to re-walk the whole noise stack per fragment (lavaDomain alone is
 * nine fbm evaluations, and crustHeight was finite-differenced four times).
 * That is hundreds of noise evaluations per pixel, which is what melted
 * phones. Instead, the smooth fields are evaluated ONCE into three fragment
 * volumes plus a small vertex-displacement volume, while the high-frequency
 * mineral and sharp-crust registers are baked into seamless mipmapped 2D
 * tiles. The live shader pays filtered texture taps instead of repeated
 * noise walks.
 *
 * Storage is a 2D atlas of Z slices rather than a 3D texture: a single
 * fullscreen pass bakes a whole volume, plain 2D sampling reads it back, and
 * nothing depends on 3D-render-target support. A volume tap is two bilinear
 * atlas taps lerped across Z.
 */

/**
 * Field-space cube the volumes cover; every demo mesh fits inside at the
 * default field scale of 1. Unlike the old fully-procedural material, samples
 * outside the cube clamp to its edge — so the material's `scale` uniform is
 * only faithful while `|position| * scale` stays within 2.4 (about 1.09 for
 * the 4.4-unit plane, the largest mesh).
 */
const VOLUME_MIN = -2.4;
const VOLUME_SPAN = 4.8;

/** Fragment volumes: 128^3 in a 12x11 grid of slices (1536x1408 rgba8). */
const SIZE = 128;
const COLS = 12;
const ROWS = 11;

/** Vertex displacement is low-frequency by design: 64^3 in 8x8 (512x512). */
const DISP_SIZE = 64;
const DISP_COLS = 8;
const DISP_ROWS = 8;

type PositionAndTimeInputs = {
  position: Node;
  t: Node;
};

type LavaBakeExports = {
  bakeGlow: PositionAndTimeInputs;
  bakeSurfaceA: PositionAndTimeInputs;
  bakeSurfaceB: PositionAndTimeInputs;
  bakeDisplacement: PositionAndTimeInputs;
  bakeMicroDetail: { tileUv: Node };
  bakeSharpDetail: { tileUv: Node };
};

const {
  bakeGlow,
  bakeSurfaceA,
  bakeSurfaceB,
  bakeDisplacement,
  bakeMicroDetail,
  bakeSharpDetail,
} = tslExports<LavaBakeExports>(lavaModule)(
  "bakeGlow",
  "bakeSurfaceA",
  "bakeSurfaceB",
  "bakeDisplacement",
  "bakeMicroDetail",
  "bakeSharpDetail",
);

export interface LavaFieldVolumes {
  /** x = sqrt(heat/1.6) sans seep, y = melt mask, z = pulse phase, w = sqrt(fringe/1.4). */
  readonly glow: THREE.Texture;
  /** x = smooth crust height, y = cooling skin, z = glass mask, w = spec mottle. */
  readonly surfaceA: THREE.Texture;
  /** x = tone, y = oxide, z = fine crevice mask, w = iridescence. */
  readonly surfaceB: THREE.Texture;
  /** x = combined vertex displacement, encoded (raw + 0.4) / 0.9. */
  readonly displacement: THREE.Texture;
  /** Seamless RGBA16F tile: grain, d/du, d/dv, and frozen-flow streaks. */
  readonly microDetail: THREE.Texture;
  /** Seamless RGBA16F tile: scabs, d/du, d/dv, and sharp cavities. */
  readonly sharpDetail: THREE.Texture;
  dispose(): void;
}

interface AtlasShape {
  readonly size: number;
  readonly cols: number;
  readonly rows: number;
}

const FRAGMENT_SHAPE: AtlasShape = { size: SIZE, cols: COLS, rows: ROWS };
const DISP_SHAPE: AtlasShape = { size: DISP_SIZE, cols: DISP_COLS, rows: DISP_ROWS };

/**
 * Trilinear volume tap: two bilinear atlas taps mixed across Z. `p` is a
 * field-space position (the same coordinates the WGSL fields take); the
 * in-slice uv is inset by half a texel so bilinear filtering never bleeds
 * into a neighboring slice.
 *
 * A texture object cannot travel through a TSL `Fn` parameter — `texture()`
 * binds at node-construction time — so the sampler closes over the atlas and
 * is cached per texture.
 */
type VolumeSampler = (p: TslNode) => TslNode;

function makeVolumeSampler(atlas: THREE.Texture, shape: AtlasShape): VolumeSampler {
  const fn = Fn(([p]: [TslNode]) => {
    const size = float(shape.size);
    const q = p.sub(vec3(VOLUME_MIN, VOLUME_MIN, VOLUME_MIN)).div(VOLUME_SPAN).clamp(0, 1).toVar();
    const zc = q.z.mul(size).sub(0.5).clamp(0, size.sub(1.001));
    const slice = zc.floor().toVar();
    const zFrac = zc.sub(slice);

    const half = float(0.5 / shape.size);
    const span = 1 - 1 / shape.size;
    const inTile = vec2(q.x.mul(span).add(half), q.y.mul(span).add(half)).toVar();

    const grid = vec2(shape.cols, shape.rows);
    const col0 = slice.mod(shape.cols);
    const row0 = slice.div(shape.cols).floor();
    const uv0 = vec2(col0, row0).add(inTile).div(grid);
    const slice1 = slice.add(1);
    const col1 = slice1.mod(shape.cols);
    const row1 = slice1.div(shape.cols).floor();
    const uv1 = vec2(col1, row1).add(inTile).div(grid);

    // Functional mix, deliberately: TSL's method form `a.mix(b, t)` does not
    // compile to mix(a, b, t) — it reorders the operands — which scrambles
    // the z interpolation. `.level(0)` keeps the taps off the implicit-
    // derivative path: uv jumps between atlas tiles at slice boundaries, and
    // wild derivatives would otherwise drive any mip logic to garbage.
    return mix(
      texture(atlas, uv0).level(float(0)),
      texture(atlas, uv1).level(float(0)),
      zFrac
    );
  });
  return (p) => fn(p) as TslNode;
}

// Keyed by texture AND shape: the same texture routed through samplers of
// different shapes must never silently reuse the other shape's atlas math.
const samplerCache = new WeakMap<THREE.Texture, Map<string, VolumeSampler>>();

function cachedSampler(atlas: THREE.Texture, shape: AtlasShape): VolumeSampler {
  let byShape = samplerCache.get(atlas);
  if (!byShape) {
    byShape = new Map();
    samplerCache.set(atlas, byShape);
  }
  const key = `${shape.size}/${shape.cols}x${shape.rows}`;
  let sampler = byShape.get(key);
  if (!sampler) {
    sampler = makeVolumeSampler(atlas, shape);
    byShape.set(key, sampler);
  }
  return sampler;
}

/** Volume tap into one of the 128^3 fragment atlases. */
export function sampleFieldVolume(atlas: THREE.Texture, p: TslNode): TslNode {
  return cachedSampler(atlas, FRAGMENT_SHAPE)(p);
}

/** Volume tap into the 64^3 displacement atlas. */
export function sampleDisplacementVolume(atlas: THREE.Texture, p: TslNode): TslNode {
  return cachedSampler(atlas, DISP_SHAPE)(p);
}

/**
 * The inverse mapping for the bake pass: which field-space position this
 * atlas texel stores. Must be the exact inverse of the sampler above.
 * `flipV` compensates for the render-target quad's uv running bottom-up
 * relative to texture rows (verified by the round-trip check in the bake).
 */
function bakePosition(shape: AtlasShape): TslNode {
  const grid = uv().mul(vec2(shape.cols, shape.rows));
  // The fullscreen quad's uv v runs opposite to texture rows (verified by an
  // analytic write/read round-trip); flip so the write lands where the
  // sampler will look.
  const flipped = vec2(grid.x, float(shape.rows).sub(grid.y));
  const cell = flipped.floor();
  const inTile = flipped.fract();
  const slice = cell.y.mul(shape.cols).add(cell.x).clamp(0, shape.size - 1);
  const half = float(0.5 / shape.size);
  const qxy = inTile.sub(half).div(half.oneMinus().sub(half)).clamp(0, 1);
  const q = vec3(qxy.x, qxy.y, slice.add(0.5).div(shape.size));
  return q.mul(VOLUME_SPAN).add(vec3(VOLUME_MIN));
}

async function bakeAtlas(
  renderer: THREE.WebGPURenderer,
  shape: AtlasShape,
  field: (p: TslNode) => TslNode,
  label: string
): Promise<{ target: THREE.RenderTarget; texture: THREE.Texture }> {
  const width = shape.cols * shape.size;
  const height = shape.rows * shape.size;
  const target = new THREE.RenderTarget(width, height, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: false,
    generateMipmaps: false,
  });
  target.texture.name = label;
  target.texture.minFilter = THREE.LinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = THREE.ClampToEdgeWrapping;
  target.texture.wrapT = THREE.ClampToEdgeWrapping;

  const material = new THREE.MeshBasicNodeMaterial();
  // The alpha channel carries data, so the bake must write the raw vec4.
  // Neither a vec4 colorNode nor opacityNode reaches the target's alpha
  // untouched (verified: every baked .w channel read back as exactly 1.0);
  // fragmentNode bypasses the material's color/opacity pipeline entirely and
  // emits the value verbatim.
  material.fragmentNode = field(bakePosition(shape));
  material.blending = THREE.NoBlending;
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const previousTarget = renderer.getRenderTarget();
  const previousToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(target);
  try {
    await renderer.renderAsync(scene, camera);
  } catch (error) {
    // A failed bake must not strand the renderer pointed at a half-written
    // atlas, nor leak the target.
    target.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.toneMapping = previousToneMapping;
    quad.geometry.dispose();
    material.dispose();
  }
  return { target, texture: target.texture };
}

/**
 * Bake a high-frequency periodic register into one mipmapped 2D tile.
 * RGBA16F plus the full mip chain occupies approximately 10.7 MiB.
 */
async function bakePeriodicDetailTile(
  renderer: THREE.WebGPURenderer,
  field: (tileUv: TslNode) => TslNode,
  label: string
): Promise<{ target: THREE.RenderTarget; texture: THREE.Texture }> {
  const target = new THREE.RenderTarget(1024, 1024, {
    format: THREE.RGBAFormat,
    type: THREE.HalfFloatType,
    depthBuffer: false,
    generateMipmaps: true,
  });
  target.texture.name = label;
  target.texture.colorSpace = THREE.NoColorSpace;
  target.texture.minFilter = THREE.LinearMipmapLinearFilter;
  target.texture.magFilter = THREE.LinearFilter;
  target.texture.wrapS = THREE.RepeatWrapping;
  target.texture.wrapT = THREE.RepeatWrapping;

  const material = new THREE.MeshBasicNodeMaterial();
  // Render-target rows run opposite the authored texture-v direction. Bake
  // with the same explicit flip as the volume atlas so derivatives retain
  // their authored signs when the texture is sampled later.
  const bakeUv = vec2(uv().x, uv().y.oneMinus());
  material.fragmentNode = field(bakeUv);
  material.blending = THREE.NoBlending;
  const scene = new THREE.Scene();
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material);
  scene.add(quad);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

  const previousTarget = renderer.getRenderTarget();
  const previousToneMapping = renderer.toneMapping;
  renderer.toneMapping = THREE.NoToneMapping;
  renderer.setRenderTarget(target);
  try {
    await renderer.renderAsync(scene, camera);
  } catch (error) {
    target.dispose();
    throw error;
  } finally {
    renderer.setRenderTarget(previousTarget);
    renderer.toneMapping = previousToneMapping;
    quad.geometry.dispose();
    material.dispose();
  }
  return { target, texture: target.texture };
}

/**
 * Bake all field volumes and the seamless detail tiles. One-time cost
 * roughly comparable to a couple of frames of the old per-fragment material;
 * every frame after is texture taps. `timeNode` freezes the fields at its
 * current value — the slow domain drift is baked in, the breathing pulse stays
 * live in the material.
 */
export async function bakeLavaVolumes(
  renderer: THREE.WebGPURenderer,
  timeNode?: Node
): Promise<LavaFieldVolumes> {
  // The fields drift extremely slowly with t; freezing them at the start (or
  // at the caller's fixed still time) is visually indistinguishable.
  const t = timeNode ?? float(0);
  const passes = [
    { shape: FRAGMENT_SHAPE, field: (p: TslNode) => bakeGlow({ position: p, t }), label: "lava-bake-glow" },
    { shape: FRAGMENT_SHAPE, field: (p: TslNode) => bakeSurfaceA({ position: p, t }), label: "lava-bake-surface-a" },
    { shape: FRAGMENT_SHAPE, field: (p: TslNode) => bakeSurfaceB({ position: p, t }), label: "lava-bake-surface-b" },
    { shape: DISP_SHAPE, field: (p: TslNode) => bakeDisplacement({ position: p, t }), label: "lava-bake-displacement" },
  ] as const;

  const targets: THREE.RenderTarget[] = [];
  try {
    for (const pass of passes) {
      const baked = await bakeAtlas(renderer, pass.shape, pass.field, pass.label);
      targets.push(baked.target);
    }
    const microDetail = await bakePeriodicDetailTile(
      renderer,
      (tileUv) => bakeMicroDetail({ tileUv }),
      "lava-bake-micro-detail"
    );
    targets.push(microDetail.target);
    const sharpDetail = await bakePeriodicDetailTile(
      renderer,
      (tileUv) => bakeSharpDetail({ tileUv }),
      "lava-bake-sharp-detail"
    );
    targets.push(sharpDetail.target);
  } catch (error) {
    // A later bake failing must not leak the earlier atlases.
    for (const target of targets) target.dispose();
    throw error;
  }

  const [glow, surfaceA, surfaceB, displacement, microDetail, sharpDetail] = targets;
  return {
    glow: glow.texture,
    surfaceA: surfaceA.texture,
    surfaceB: surfaceB.texture,
    displacement: displacement.texture,
    microDetail: microDetail.texture,
    sharpDetail: sharpDetail.texture,
    dispose() {
      for (const target of targets) target.dispose();
    },
  };
}
