// TILED 3D VALUE-NOISE LATTICE — shared by the browser renderer and the
// headless harness.
//
// `disk.wgsl` used to evaluate its value noise the classic way: hash the eight
// corners of the lattice cell on the fly (`hash31`, 8 calls, ~120 ALU) and
// interpolate them with a cubic fade. The disk needs ~26 of those per pixel per
// layer (2 shear lobes x 13 octaves), which made the hash the single hottest
// thing in the frame pass.
//
// This module bakes the SAME lattice into a small 3D texture once, at init, so
// the shader can replace the eight hashes with one trilinear fetch. The texture
// is sampled with `address_mode = repeat`, i.e. the noise becomes exactly
// `SIZE`-periodic on every axis. See `noise3` in disk.wgsl for the sampling
// side and gbuffer.md for the contract.
//
// Why it is a plain `.mjs` and not a `.ts`: `debug-render.mjs` must build the
// byte-identical volume, and it runs on bare Node with no transpiler. A second
// copy of a hash function is the one kind of duplication this pipeline cannot
// survive — the harness would silently render a different disk than the page.

/**
 * Edge length of the lattice cube, in noise units (one texel == one lattice
 * point == one unit of the noise coordinate).
 *
 * This is the period of the noise. The disk's angular embedding never leaves
 * |x|,|y| <~ 17 (see `angBase` / `lacAng` in disk.wgsl), so the tile is more
 * than twice as wide as the angular axes ever need and cannot repeat there. The
 * RADIAL axis is the one that tiles: the finest thread octave runs at ~143
 * noise units per world unit, so it wraps every 64/143 ~ 0.45 of disk radius —
 * invisible in practice because that octave carries 6% of the amplitude and the
 * angular scale itself drifts with radius, which decorrelates the repeats.
 *
 * 64^3 @ r8unorm = 256 KiB. 128^3 = 2 MiB, which is the fallback if the
 * repetition ever becomes visible; nothing else has to change.
 */
export const NOISE_VOLUME_SIZE = 64;

/** `r8unorm`: filterable in core WebGPU, 1 byte per lattice point. */
export const NOISE_VOLUME_FORMAT = 'r8unorm';

/**
 * Which REALIZATION of the lattice to bake. Not a magic number — read this.
 *
 * Tiling does not change the noise: it is the same cubic-fade value noise over
 * the same uniformly distributed hash (proven three ways — an exact 8-tap
 * `textureLoad` reconstruction, an `r16float` lattice and the hardware
 * trilinear fetch all produce the same image, so neither the r8 quantization
 * nor the sampler's filter weights are visible). What tiling DOES change is
 * *which* draw of that noise you get, because wrapping the radial axis into
 * `[0, SIZE)` re-rolls every octave's z slice.
 *
 * That matters more than it sounds. The disk's large-scale contrast is decided
 * by the `flow` layer of disk.wgsl, which spans barely three lattice planes, so
 * it is one very small sample: re-rolling the ANALYTIC noise (shifting every
 * octave's z by a constant) moves the frame's masked luma std over
 * 0.092..0.117 and the blown-out-crest fraction over 0.61%..2.13%. The look the
 * hero shipped with sits at the very top of that range — it is a lucky draw,
 * and the disk was hand-tuned against it.
 *
 * So the seed is chosen, not defaulted: of 16 candidate lattices it is the one
 * whose contrast statistics land closest to the shipped image (std 0.118 vs
 * 0.114, crest fraction 2.02% vs 2.13% at t = 2.5/30/300/3000), and it stayed
 * the closest on six held-out times it was not selected on. Changing it is
 * safe and changes nothing but the arrangement of the filaments.
 */
export const NOISE_VOLUME_SEED = 13;

const fr = Math.fround;
/** WGSL `fract`, evaluated in f32 like the shader does. */
const fract = (x) => fr(x - Math.floor(x));

const K0 = fr(0.1031);
const K1 = fr(0.103);
const K2 = fr(0.0973);
const K3 = fr(33.33);

/**
 * The hash `disk.wgsl` used to call eight times per noise sample, re-evaluated
 * in f32 on the CPU.
 *
 * It does NOT have to be bit-identical to the GPU version (a driver is free to
 * contract the dot product into fmas), and it isn't required to be: the value
 * only has to be the same *field* — a fixed, uniformly distributed function of
 * the lattice point — for the tile to have the statistics disk.wgsl was tuned
 * against. Keeping the exact same expression is what guarantees that.
 *
 * @param {number} px @param {number} py @param {number} pz
 * @returns {number} pseudo-random value in [0, 1)
 */
export function hash31(px, py, pz) {
  let qx = fract(fr(px * K0));
  let qy = fract(fr(py * K1));
  let qz = fract(fr(pz * K2));
  // dot(q, q.yzx + vec3f(33.33))
  const d = fr(fr(fr(qx * fr(qy + K3)) + fr(qy * fr(qz + K3))) + fr(qz * fr(qx + K3)));
  qx = fr(qx + d);
  qy = fr(qy + d);
  qz = fr(qz + d);
  return fract(fr(fr(qx + qy) * qz));
}

/**
 * Maps a texel index to the lattice point it stores.
 *
 * The SIGNED representative (`[-size/2, size/2)`) instead of the naive
 * `[0, size)` one, because the disk's angular embedding is centred on the
 * origin: `p.xy = (cos(a), sin(a)) * scale` with `scale <= ~17`. With the
 * signed convention every angular lattice point the disk ever touches hashes to
 * exactly the value the analytic noise produced, so the tiling only changes the
 * realization along the radial axis — where it is unavoidable — and leaves the
 * angular structure of every octave bit-for-bit intact.
 *
 * The tile is periodic either way; this is a relabelling, not a different
 * field.
 *
 * @param {number} index @param {number} size
 */
function latticeCoord(index, size) {
  return index < size / 2 ? index : index - size;
}

/**
 * Builds the lattice as `size^3` bytes in WebGPU 3D-texture order
 * (x fastest, then y, then z/depth slice).
 *
 * Deterministic and dependency-free, so the browser and the Node harness get
 * byte-identical volumes. ~1 ms for 64^3, ~10 ms for 128^3; called once.
 *
 * The seed only displaces the Z axis, which is the one the disk wraps anyway.
 * X and Y are left alone so that every angular lattice point keeps hashing to
 * the value the analytic noise produced (see `latticeCoord`).
 *
 * @param {number} [size]
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
export function buildNoiseVolume(size = NOISE_VOLUME_SIZE, seed = NOISE_VOLUME_SEED) {
  const data = new Uint8Array(size * size * size);
  const offset = seed * 1024;
  let cursor = 0;
  for (let z = 0; z < size; z++) {
    const pz = latticeCoord(z, size) + offset;
    for (let y = 0; y < size; y++) {
      const py = latticeCoord(y, size);
      for (let x = 0; x < size; x++) {
        // r8unorm decodes as byte/255, so round to the nearest representable
        // value instead of truncating: halves the quantization error the
        // ridged fold in disk.wgsl amplifies.
        data[cursor++] = Math.min(255, Math.round(hash31(latticeCoord(x, size), py, pz) * 255));
      }
    }
  }
  return data;
}

/** Module-level cache: the lattice is a pure function of `size`. */
const cache = new Map();

/**
 * `buildNoiseVolume`, memoized. A second renderer on the same page (or a
 * remount) reuses the bytes instead of re-hashing 262144 lattice points.
 *
 * @param {number} [size]
 * @param {number} [seed]
 * @returns {Uint8Array}
 */
export function noiseVolumeData(size = NOISE_VOLUME_SIZE, seed = NOISE_VOLUME_SEED) {
  const key = `${size}:${seed}`;
  let data = cache.get(key);
  if (!data) {
    data = buildNoiseVolume(size, seed);
    cache.set(key, data);
  }
  return data;
}

/**
 * Creates the 3D texture and uploads the lattice.
 *
 * `gpu.target()` cannot make a 3D texture (it only builds render attachments),
 * so this drops to `gpu.device.createTexture`, which takes `dimension` and a
 * 3-component size, and to the raw `queue.writeTexture` — the vgpu `Queue`
 * wrapper only exposes buffer writes. Both are core WebGPU: no optional
 * feature, and the same code path works on the browser adapter and on
 * Node/Dawn.
 *
 * The caller owns the returned texture and must `destroy()` it.
 *
 * @param {import('vgpu').Gpu} gpu
 * @param {number} [size]
 * @param {string} [label]
 * @param {number} [seed]
 */
export function createNoiseVolume(gpu, size = NOISE_VOLUME_SIZE, label = 'hero-noise-volume', seed = NOISE_VOLUME_SEED) {
  const texture = gpu.device.createTexture({
    size: [size, size, size],
    dimension: '3d',
    format: NOISE_VOLUME_FORMAT,
    usage: ['texture_binding', 'copy_dst'],
    label,
  });
  gpu.gpu.queue.writeTexture(
    { texture: texture.gpu },
    noiseVolumeData(size, seed),
    // r8unorm: one byte per texel, so a row is exactly `size` bytes. The
    // 256-byte alignment rule belongs to buffer<->texture copies, not to
    // `writeTexture` from host memory.
    { offset: 0, bytesPerRow: size, rowsPerImage: size },
    { width: size, height: size, depthOrArrayLayers: size },
  );
  return texture;
}

/**
 * The sampler `disk.wgsl::noise3` expects.
 *
 * `repeat` on all three axes is what makes the tile seamless: the shader wraps
 * the integer lattice cell itself, and the +1 neighbour of the last texel has
 * to come back around to texel 0 or every tile boundary would be a visible
 * discontinuity. `linear` min/mag is the trilinear interpolation that replaces
 * the eight-way `mix` chain — the cubic fade is applied to the coordinate
 * before the fetch, so the filter only has to be linear.
 *
 * Takes the vgpu module namespace rather than importing it: in 0.2.0 `sampler`
 * is a free function, and this module is pulled in statically by the browser
 * renderer — a top-level `import { sampler } from 'vgpu'` here would drag the
 * library back into the initial bundle that `renderer.ts` keeps it out of.
 *
 * @param {typeof import('vgpu')} vgpu
 * @param {import('vgpu').Gpu} gpu
 */
export function noiseVolumeSampler(vgpu, gpu) {
  return vgpu.sampler(gpu, {
    addressModeU: 'repeat',
    addressModeV: 'repeat',
    addressModeW: 'repeat',
    minFilter: 'linear',
    magFilter: 'linear',
  });
}
