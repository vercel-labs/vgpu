// Environment-agnostic FFT ocean scene. It holds the storage buffers, the four
// compute passes (spectrum init/update + the two IFFT passes), the skydome and
// ocean draws, and the tone-mapping composite. The vgpu runtime functions are
// injected as `api` so the exact same setup runs against `vgpu` (browser) and
// `vgpu/node` (headless render + tests). WGSL sources are injected too.
//
// All the knobs a user tweaks live in `scene.params`. Render/sun params are read
// live every frame; the spectrum params (wind/amplitude/patch) require rebuilding
// h0, so call `rebuildSpectrum()` after changing them.

import { sphere } from "vgpu/scene";

export type OceanApi = {
  compute: typeof import("vgpu").compute;
  storage: typeof import("vgpu").storage;
  draw: typeof import("vgpu").draw;
  geometry: typeof import("vgpu").geometry;
  effect: typeof import("vgpu").effect;
  target: typeof import("vgpu").target;
  sampler: typeof import("vgpu").sampler;
};

type Gpu = Parameters<OceanApi["compute"]>[0];
type ShaderSrc = Parameters<OceanApi["compute"]>[1];

export type OceanShaders = {
  spectrumInit: ShaderSrc;
  spectrumUpdate: ShaderSrc;
  fftRow: ShaderSrc;
  fftCol: ShaderSrc;
  bake: ShaderSrc;
  oceanSurface: ShaderSrc;
  skydome: ShaderSrc;
  composite: ShaderSrc;
};

/** Everything the lil-gui panel drives. */
export interface OceanParams {
  windSpeed: number; // m/s (spectrum)
  windAngle: number; // degrees (spectrum)
  amplitude: number; // Phillips amplitude (spectrum)
  patchSize: number; // meters per FFT tile (spectrum + render tiling)
  heightScale: number; // vertical displacement gain (render)
  choppyScale: number; // horizontal displacement gain (render)
  foamScale: number; // foam Jacobian threshold (render)
  sunElevation: number; // degrees above horizon (sky)
  sunAzimuth: number; // degrees (sky)
  timeScale: number; // simulation speed multiplier
}

export const DEFAULT_PARAMS: OceanParams = {
  windSpeed: 24,
  windAngle: 18,
  amplitude: 4,
  patchSize: 265,
  heightScale: 34,
  choppyScale: 14,
  foamScale: 0.5,
  sunElevation: 6.5,
  sunAzimuth: 236,
  timeScale: 1,
};

export interface OceanOptions {
  size: readonly [number, number];
  worldSize?: number;
  skyRadius?: number;
  params?: Partial<OceanParams>;
  clear?: readonly [number, number, number, number];
}

const N = 256;
const CPLX_BYTES = N * N * 2 * 4; // array<vec2f>
const VEC4_BYTES = N * N * 4 * 4; // array<vec4f>

// Procedural ocean grid resolution (cells per side). 6 vertices per cell, no
// vertex buffer, so this is not capped by 16-bit indices. Sent to the shader as
// the `GRID` override to stay in sync with the draw's vertex count.
const OCEAN_GRID = 512;

const DEG = Math.PI / 180;

export interface OceanScene {
  readonly params: OceanParams;
  /** Recompute the time-independent spectrum h0 (after wind/amplitude/patch changes). */
  rebuildSpectrum(): void;
  /** Advance the simulation by `dt` seconds (scaled by params.timeScale) and run the IFFT. */
  simulate(dt: number): void;
  /** Push camera + live render/sun params into the ocean and skydome uniforms. */
  updateCamera(viewProj: Float32Array, camPos: Float32Array): void;
  resize(size: readonly [number, number]): void;
  dispose(): void;
  readonly hdr: ReturnType<OceanApi["target"]>;
  readonly skydome: ReturnType<OceanApi["draw"]>;
  readonly ocean: ReturnType<OceanApi["draw"]>;
  readonly composite: ReturnType<OceanApi["effect"]>;
  readonly clear: readonly [number, number, number, number];
}

export function buildOcean(
  gpu: Gpu,
  api: OceanApi,
  shaders: OceanShaders,
  opts: OceanOptions,
): OceanScene {
  const worldSize = opts.worldSize ?? 1000;
  const skyRadius = opts.skyRadius ?? 6000;
  const clear = opts.clear ?? [0.02, 0.02, 0.04, 1];
  const params: OceanParams = { ...DEFAULT_PARAMS, ...opts.params };

  const windDir = (): [number, number] => {
    const a = params.windAngle * DEG;
    return [Math.cos(a), Math.sin(a)];
  };
  const sunDir = (): [number, number, number] => {
    const el = params.sunElevation * DEG;
    const az = params.sunAzimuth * DEG;
    return [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  };
  const simUniform = (time: number) => ({
    windDir: windDir(),
    windSpeed: params.windSpeed,
    amplitude: params.amplitude,
    patchSize: params.patchSize,
    time,
  });

  // --- storage buffers -------------------------------------------------------
  const h0 = api.storage(gpu, VEC4_BYTES, "read-write");
  const specX = api.storage(gpu, CPLX_BYTES, "read-write");
  const specY = api.storage(gpu, CPLX_BYTES, "read-write");
  const specZ = api.storage(gpu, CPLX_BYTES, "read-write");
  const tmpX = api.storage(gpu, CPLX_BYTES, "read-write");
  const tmpY = api.storage(gpu, CPLX_BYTES, "read-write");
  const tmpZ = api.storage(gpu, CPLX_BYTES, "read-write");
  const disp = api.storage(gpu, VEC4_BYTES, "read-write");

  // --- compute passes --------------------------------------------------------
  const initPass = api.compute(gpu, shaders.spectrumInit, {
    label: "spectrum-init",
    set: { h0, sim: simUniform(0) },
  });
  const updatePass = api.compute(gpu, shaders.spectrumUpdate, {
    label: "spectrum-update",
    set: { h0, specX, specY, specZ, sim: simUniform(0) },
  });
  const rowPass = api.compute(gpu, shaders.fftRow, {
    label: "fft-row",
    set: { inX: specX, inY: specY, inZ: specZ, outX: tmpX, outY: tmpY, outZ: tmpZ },
  });
  const colPass = api.compute(gpu, shaders.fftCol, {
    label: "fft-col",
    set: { inX: tmpX, inY: tmpY, inZ: tmpZ, disp },
  });

  // Bake the IFFT storage buffer into a texture the render stages can sample —
  // storage buffers are not available in the vertex stage on all adapters.
  const dispTex = api.target(gpu, { size: [N, N], format: "rgba16float" });
  const dispSamp = api.sampler(gpu, {
    addressModeU: "repeat",
    addressModeV: "repeat",
    minFilter: "linear",
    magFilter: "linear",
  });
  const bake = api.effect(gpu, shaders.bake, { label: "bake-displacement", set: { disp } });

  // --- geometry / draws / composite -----------------------------------------
  const skyGeo = api.geometry(gpu, sphere({ radius: 1 }));
  const identityCam = new Float32Array(16);

  const skydome = api.draw(gpu, {
    label: "skydome",
    shader: shaders.skydome,
    geometry: skyGeo,
    cull: "front",
    set: { u: { viewProj: identityCam, camPos: [0, 0, 0], radius: skyRadius, sunDir: sunDir() } },
  });
  const ocean = api.draw(gpu, {
    label: "ocean",
    shader: shaders.oceanSurface,
    cull: "none",
    constants: { GRID: OCEAN_GRID },
    vertices: 6 * OCEAN_GRID * OCEAN_GRID,
    set: {
      u: {
        viewProj: identityCam,
        camPos: [0, 0, 0],
        worldSize,
        sunDir: sunDir(),
        patchSize: params.patchSize,
        heightScale: params.heightScale,
        choppyScale: params.choppyScale,
        foamScale: params.foamScale,
      },
      disp: dispTex,
      dispSamp,
    },
  });

  const hdr = api.target(gpu, { size: [opts.size[0], opts.size[1]], format: "rgba16float", depth: true });
  const samp = api.sampler(gpu, { minFilter: "linear", magFilter: "linear" });
  const composite = api.effect(gpu, shaders.composite, {
    label: "composite",
    set: { src: hdr, samp },
  });

  let simTime = 0;

  function rebuildSpectrum() {
    initPass.set({ sim: simUniform(0) });
    initPass.dispatch(N / 8, N / 8);
  }

  rebuildSpectrum(); // build h0 once at startup

  return {
    params,
    hdr,
    skydome,
    ocean,
    composite,
    clear,
    rebuildSpectrum,
    simulate(dt: number) {
      simTime += dt * params.timeScale;
      updatePass.set({ sim: simUniform(simTime) });
      updatePass.dispatch(N / 8, N / 8);
      rowPass.dispatch(N, 1);
      colPass.dispatch(N, 1);
      bake.draw(dispTex); // storage buffer -> sampleable displacement texture
    },
    updateCamera(viewProj: Float32Array, camPos: Float32Array) {
      const cp = [camPos[0], camPos[1], camPos[2]] as [number, number, number];
      const s = sunDir();
      skydome.set({ u: { viewProj, camPos: cp, radius: skyRadius, sunDir: s } });
      ocean.set({
        u: {
          viewProj,
          camPos: cp,
          worldSize,
          sunDir: s,
          patchSize: params.patchSize,
          heightScale: params.heightScale,
          choppyScale: params.choppyScale,
          foamScale: params.foamScale,
        },
      });
    },
    resize(size: readonly [number, number]) {
      hdr.resize([size[0], size[1]]);
      composite.set({ src: hdr, samp });
    },
    dispose() {
      // Buffers/targets are owned by the device; callers dispose `gpu` on teardown.
    },
  };
}
