import type { Geometry, Gpu } from "vgpu";
import { sampler } from "vgpu";

import { cameraView } from "../scene/camera";
import {
  createEnvironmentSampler,
  createEnvironmentTexture,
  destroyEnvironmentTexture,
  prepareEnvironmentTexture,
} from "../environment/texture";
import { IDENTITY_PROJECTION_FRAMING } from "../scene/framing";
import {
  buildLightMesh,
  HIGH_LIGHT_MESH_LAYOUT,
  LIGHT_VERTEX_STRIDE,
  type LightMeshLayout,
} from "../scene/light-mesh";
import { prismGeometry, prismWireframeGeometry } from "../scene/prism-mesh";
import {
  CAMERA_DISTANCE,
  DEFAULT_PRISM_CONTROLS,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
} from "../types";
import { normalizeControls } from "./normalize-controls";
import { settleAllOrThrow } from "./settle";
import { lampAt, wallExtent } from "./state";
import type { PrismRuntime } from "./types";

export interface PrismRuntimeOptions {
  /** Bake the preview-only orientation environment alongside the studio. */
  readonly debugEnvironment?: boolean;
  /** Initial light density; the GPU buffer still reserves the high-tier size. */
  readonly lightMeshLayout?: LightMeshLayout;
}

export function createPrismRuntime(
  gpu: Gpu,
  output: readonly [number, number],
  label: string,
  options: PrismRuntimeOptions = {}
): PrismRuntime {
  const controls = normalizeControls(DEFAULT_PRISM_CONTROLS);
  const aspect = output[0] / Math.max(1, output[1]);
  const lightVertexScratch: number[] = [];
  const meshLayout = options.lightMeshLayout ?? HIGH_LIGHT_MESH_LAYOUT;
  const initialMesh = buildLightMesh(
    {
      light: lampAt(
        PRISM_DEFAULT_ARC,
        controls.beamWidth,
        0.5,
        controls.beamMouseY
      ),
      dispersion:
        controls.spectralDispersion ??
        PRISM_DISPERSION_PRESETS[controls.dispersion],
      edgeFalloff: controls.lightFade.edgeFalloff,
      wallHalfExtent: wallExtent(aspect, CAMERA_DISTANCE, controls.cameraFov),
      samples: meshLayout.samples,
      beamSlices: meshLayout.beamSlices,
    },
    undefined,
    lightVertexScratch
  );
  const lightBuffer = gpu.device.createBuffer({
    size: HIGH_LIGHT_MESH_LAYOUT.vertexCount * LIGHT_VERTEX_STRIDE,
    usage: ["vertex", "copy_dst"],
    label: `${label}.light-vertices`,
  });
  lightBuffer.write(initialMesh.vertices);
  const prism = prismGeometry(gpu, `${label}.prism`);

  return {
    gpu,
    label,
    outputSize: output,
    lightBuffer,
    lightVertexScratch,
    lightVertices: initialMesh.vertices,
    lightMeshLayout: meshLayout,
    lightGeometry: {
      vertexBuffers: [lightBuffer.gpu],
      vertexBufferLayouts: [
        {
          arrayStride: LIGHT_VERTEX_STRIDE,
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 3, offset: 8, format: "float32" },
          ],
        },
      ],
      vertexCount: meshLayout.vertexCount,
    },
    prism,
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
    environmentSampler: createEnvironmentSampler(gpu),
    debugEnvironmentEnabled: options.debugEnvironment === true,
    controls,
    lightStats: initialMesh.stats,
    lampArc: PRISM_DEFAULT_ARC,
    lampTarget: 0.5,
    orbit: [0, 0],
    aspect,
    cameraDistance: CAMERA_DISTANCE,
    framing: IDENTITY_PROJECTION_FRAMING,
    view: cameraView(aspect, 0, 0, CAMERA_DISTANCE, controls.cameraFov),
  };
}

/** Uploads debug-only prism edges on first use, then shares them across modes. */
export function ensurePrismWireframeGeometry(runtime: PrismRuntime): Geometry {
  runtime.prismWireframe ??= prismWireframeGeometry(
    runtime.gpu,
    `${runtime.label}.prism-wireframe`
  );
  return runtime.prismWireframe;
}

/** Builds the shared environment once; the debug map is strictly opt-in. */
export function prepareRuntimeEnvironment(
  runtime: PrismRuntime
): Promise<void> {
  if (runtime.environmentReady) return runtime.environmentReady;
  runtime.studioEnvironment ??= createEnvironmentTexture(
    runtime.gpu,
    `${runtime.label}.environment-studio`,
    false
  );
  const environments = [runtime.studioEnvironment];
  if (runtime.debugEnvironmentEnabled) {
    runtime.debugEnvironment ??= createEnvironmentTexture(
      runtime.gpu,
      `${runtime.label}.environment-debug`,
      true
    );
    environments.push(runtime.debugEnvironment);
  }
  runtime.environmentReady = settleAllOrThrow(
    environments.map((environment) =>
      prepareEnvironmentTexture(
        runtime.gpu,
        environment,
        runtime.environmentSampler
      )
    )
  );
  return runtime.environmentReady;
}

export function destroyPrismRuntime(runtime: PrismRuntime): void {
  destroyEnvironmentTexture(runtime.studioEnvironment);
  runtime.studioEnvironment = undefined;
  destroyEnvironmentTexture(runtime.debugEnvironment);
  runtime.debugEnvironment = undefined;
  runtime.environmentReady = undefined;
  runtime.lightBuffer.destroy();
  runtime.prism.destroy();
  runtime.prismWireframe?.destroy();
  runtime.prismWireframe = undefined;
}
