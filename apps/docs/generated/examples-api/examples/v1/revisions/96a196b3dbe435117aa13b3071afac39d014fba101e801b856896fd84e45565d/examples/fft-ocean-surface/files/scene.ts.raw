import {
  compute,
  draw,
  effect,
  geometry,
  sampler,
  storage,
  target,
  type Gpu,
} from "vgpu";
import { sphere } from "vgpu/scene";

import bakeShader from "./bake.wgsl";
import compositeWgsl from "./composite.wgsl";
import fftColWgsl from "./fft-col.wgsl";
import fftRowWgsl from "./fft-row.wgsl";
import oceanSurfaceWgsl from "./ocean-surface.wgsl";
import skydomeWgsl from "./skydome.wgsl";
import spectrumInitWgsl from "./spectrum-init.wgsl";
import spectrumUpdateWgsl from "./spectrum-update.wgsl";

export const OCEAN_CAMERA = {
  fov: 48,
  near: 1,
  far: 8000,
  position: [0, 24, 128] as const,
  target: [0, 5, 0] as const,
};

export const DEFAULT_PARAMS = {
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

export type OceanParams = typeof DEFAULT_PARAMS;
type Destroyable = { destroy(): void };
type Size = readonly [number, number];

const N = 256;
const COMPLEX_BYTES = N * N * 2 * 4;
const VEC4_BYTES = N * N * 4 * 4;
const GRID = 512;
const WORLD_SIZE = 1000;
const SKY_RADIUS = 6000;
const DEG = Math.PI / 180;
const CLEAR = [0.02, 0.02, 0.04, 1] as const;

export function buildOcean(gpu: Gpu, size: Size) {
  const resources = new Set<object>();
  const own = <T extends object>(resource: T): T => {
    resources.add(resource);
    return resource;
  };
  const release = (resource: object): void => {
    resources.delete(resource);
    (resource as Destroyable).destroy();
  };

  try {
    const params: OceanParams = { ...DEFAULT_PARAMS };
    const windDir = (): [number, number] => {
      const angle = params.windAngle * DEG;
      return [Math.cos(angle), Math.sin(angle)];
    };
    const sunDir = (): [number, number, number] => {
      const elevation = params.sunElevation * DEG;
      const azimuth = params.sunAzimuth * DEG;
      return [
        Math.cos(elevation) * Math.cos(azimuth),
        Math.sin(elevation),
        Math.cos(elevation) * Math.sin(azimuth),
      ];
    };
    const simUniform = (time: number) => ({
      windDir: windDir(),
      windSpeed: params.windSpeed,
      amplitude: params.amplitude,
      patchSize: params.patchSize,
      time,
    });
    const skyUniform = (
      viewProj: Float32Array,
      camPos: readonly [number, number, number],
      sun = sunDir()
    ) => ({ viewProj, camPos, radius: SKY_RADIUS, sunDir: sun });

    let h0 = own(storage(gpu, VEC4_BYTES, "read-write"));
    const specX = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const specY = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const specZ = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const tmpX = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const tmpY = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const tmpZ = own(storage(gpu, COMPLEX_BYTES, "read-write"));
    const displacement = own(storage(gpu, VEC4_BYTES, "read-write"));

    const initPass = compute(gpu, spectrumInitWgsl, {
      set: { h0, sim: simUniform(0) },
    });
    const updatePass = compute(gpu, spectrumUpdateWgsl, {
      set: { h0, specX, specY, specZ, sim: simUniform(0) },
    });
    const rowPass = compute(gpu, fftRowWgsl, {
      set: {
        inX: specX,
        inY: specY,
        inZ: specZ,
        outX: tmpX,
        outY: tmpY,
        outZ: tmpZ,
      },
    });
    const colPass = compute(gpu, fftColWgsl, {
      set: { inX: tmpX, inY: tmpY, inZ: tmpZ, disp: displacement },
    });

    const displacementTarget = own(
      target(gpu, { size: [N, N], format: "rgba16float" })
    );
    const displacementSampler = sampler(gpu, {
      addressModeU: "repeat",
      addressModeV: "repeat",
      minFilter: "linear",
      magFilter: "linear",
    });
    const bake = effect(gpu, bakeShader, {
      set: { disp: displacement },
    });

    const skyGeometry = own(geometry(gpu, sphere({ radius: 1 })));
    const identity = new Float32Array(16);
    const skydome = draw(gpu, {
      shader: skydomeWgsl,
      geometry: skyGeometry,
      cull: "front",
      set: { u: skyUniform(identity, [0, 0, 0]) },
    });
    const ocean = draw(gpu, {
      shader: oceanSurfaceWgsl,
      cull: "none",
      constants: { GRID },
      vertices: 6 * GRID * GRID,
      set: {
        u: oceanUniform(identity, [0, 0, 0]),
        disp: displacementTarget,
        dispSamp: displacementSampler,
      },
    });

    let hdr = own(
      target(gpu, {
        size: [size[0], size[1]],
        format: "rgba16float",
        depth: true,
      })
    );
    const linearSampler = sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
    });
    const composite = effect(gpu, compositeWgsl, {
      set: { src: hdr, samp: linearSampler },
    });
    let simTime = 0;
    let destroyed = false;

    initPass.set({ sim: simUniform(0) });
    initPass.dispatch(N / 8, N / 8);

    return {
      params,
      get hdr() {
        return hdr;
      },
      skydome,
      ocean,
      composite,
      clear: CLEAR,
      rebuildSpectrum() {
        const nextH0 = own(storage(gpu, VEC4_BYTES, "read-write"));
        try {
          const nextPass = compute(gpu, spectrumInitWgsl, {
            set: { h0: nextH0, sim: simUniform(0) },
          });
          nextPass.dispatch(N / 8, N / 8);
          updatePass.set({ h0: nextH0 });
        } catch (error) {
          rethrow(error, () => release(nextH0));
        }
        const previous = h0;
        h0 = nextH0;
        release(previous);
      },
      simulate(dt: number) {
        simTime += dt * params.timeScale;
        updatePass.set({ sim: simUniform(simTime) });
        updatePass.dispatch(N / 8, N / 8);
        rowPass.dispatch(N, 1);
        colPass.dispatch(N, 1);
        bake.draw(displacementTarget);
      },
      updateCamera(viewProj: Float32Array, camPos: Float32Array) {
        const position: [number, number, number] = [
          camPos[0],
          camPos[1],
          camPos[2],
        ];
        const sun = sunDir();
        skydome.set({ u: skyUniform(viewProj, position, sun) });
        ocean.set({ u: oceanUniform(viewProj, position, sun) });
      },
      resize(size: Size) {
        if (hdr.size[0] === size[0] && hdr.size[1] === size[1]) return;
        const next = own(
          target(gpu, {
            size: [size[0], size[1]],
            format: "rgba16float",
            depth: true,
          })
        );
        try {
          composite.set({ src: next, samp: linearSampler });
        } catch (error) {
          rethrow(error, () => release(next));
        }
        const previous = hdr;
        hdr = next;
        release(previous);
      },
      destroy() {
        if (destroyed) return;
        destroyed = true;
        const owned = [...resources].reverse();
        resources.clear();
        destroyResources(owned);
      },
    };

    function oceanUniform(
      viewProj: Float32Array,
      camPos: readonly [number, number, number],
      sun = sunDir()
    ) {
      return {
        viewProj,
        camPos,
        worldSize: WORLD_SIZE,
        sunDir: sun,
        patchSize: params.patchSize,
        heightScale: params.heightScale,
        choppyScale: params.choppyScale,
        foamScale: params.foamScale,
      };
    }
  } catch (error) {
    rethrow(error, () => destroyResources([...resources].reverse()));
  }
}

export type OceanScene = ReturnType<typeof buildOcean>;

function destroyResources(resources: readonly object[]): void {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      (resource as Destroyable).destroy();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw errors[0];
}

function rethrow(error: unknown, cleanup: () => void): never {
  try {
    cleanup();
  } catch {
    // Cleanup must not replace the construction, rebuild, or resize error.
  }
  throw error;
}
