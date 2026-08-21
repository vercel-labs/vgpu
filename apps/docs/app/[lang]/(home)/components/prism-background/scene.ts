/**
 * Deterministic scene graph.
 *
 * The CPU traces wavelength-connected sheets across the finite beam and writes
 * them into one fixed vertex buffer. Every frame resolves wall, inner glass and
 * outer glass through two full-resolution ping-pong HDR targets, then builds a
 * four-level reduced-resolution bloom pyramid before the sole tone-mapped
 * presentation pass. There is no temporal history or convergence state.
 */

import type {
  Buffer,
  Draw,
  Effect,
  Frame,
  Geometry,
  Gpu,
  Surface,
  Target,
} from "vgpu";
import { draw, effect, frame, sampler, target } from "vgpu";

import {
  cameraView,
  rotationMatrix,
  wallHalfHeight,
  type CameraView,
} from "./camera";
import bloomUpsampleWgsl from "./bloom-upsample.wgsl";
import bloomWgsl from "./bloom.wgsl";
import copyLinearWgsl from "./copy-linear.wgsl";
import glassBackWgsl from "./glass-back.wgsl";
import glassWgsl from "./glass.wgsl";
import {
  buildLightMesh,
  LIGHT_WHITE_QUADS,
  LIGHT_VERTEX_STRIDE,
  lightVertexCount,
  type LightMeshStats,
} from "./light-mesh";
import lightWgsl from "./light.wgsl";
import lightWireframeWgsl from "./light-wireframe.wgsl";
import presentWgsl from "./present.wgsl";
import { prismGeometry, prismWireframeGeometry } from "./prism-mesh";
import wallWgsl from "./wall.wgsl";
import wireframeWgsl from "./wireframe.wgsl";
import {
  DEFAULT_PRISM_CONTROLS,
  PRISM_BACK_Z,
  PRISM_BEAM_SLICES,
  PRISM_DEFAULT_ARC,
  PRISM_DISPERSION_PRESETS,
  PRISM_FRONT_Z,
  PRISM_GLASS,
  PRISM_INCIDENCE_ARC,
  PRISM_LIGHT_PLANE_Z,
  PRISM_LIGHT_FADE_RANGES,
  PRISM_SPECTRAL_DISPERSION_RANGES,
  PRISM_TRIANGLE,
  clampBeamWidth,
  clampCameraDistance,
  clampCameraFov,
  lampForIncidence,
  type PrismControls,
  type CollimatedLight,
} from "./types";

type Output = Surface | Target;
const ENVIRONMENT_ROTATION = rotationMatrix(PRISM_GLASS.environmentRotation);
const BLOOM_LEVELS = 4;
type BloomTargets = readonly [Target, Target, Target, Target];
type BloomEffects = readonly [Effect, Effect, Effect, Effect];
type BloomUpsampleEffects = readonly [Effect, Effect, Effect];

export interface PrismScene {
  readonly gpu: Gpu;
  outputSize: readonly [number, number];
  sceneTargets?: readonly [Target, Target];
  bloomTargets?: BloomTargets;
  readonly light: Draw;
  readonly lightWireframe: Draw;
  readonly lightBuffer: Buffer;
  lightStats: LightMeshStats;
  readonly wall: Draw;
  readonly copyToBack: Effect;
  readonly copyToFront: Effect;
  readonly bloomDownsample: BloomEffects;
  readonly bloomUpsample: BloomUpsampleEffects;
  readonly present: Effect;
  readonly glassBack: Draw;
  readonly glassFront: Draw;
  readonly wireframe: Draw;
  readonly prism: Geometry;
  readonly prismWireframe: Geometry;
  readonly sceneSampler: ReturnType<typeof sampler>;
  controls: PrismControls;
  lampArc: number;
  lampTarget: number;
  orbit: readonly [number, number];
  aspect: number;
  view: CameraView;
  readonly label: string;
}

export function createScene(
  gpu: Gpu,
  output: readonly [number, number],
  label: string
): PrismScene {
  const aspect = output[0] / Math.max(1, output[1]);
  const initialMesh = buildLightMesh({
    light: lampAt(PRISM_DEFAULT_ARC, DEFAULT_PRISM_CONTROLS.beamWidth),
    dispersion:
      DEFAULT_PRISM_CONTROLS.spectralDispersion ??
      PRISM_DISPERSION_PRESETS[DEFAULT_PRISM_CONTROLS.dispersion],
    edgeFalloff: DEFAULT_PRISM_CONTROLS.lightFade.edgeFalloff,
    wallHalfExtent: wallExtent(
      aspect,
      DEFAULT_PRISM_CONTROLS.cameraDistance,
      DEFAULT_PRISM_CONTROLS.cameraFov
    ),
  });
  const lightBuffer = gpu.device.createBuffer({
    size: initialMesh.vertices.byteLength,
    usage: ["vertex", "copy_dst"],
    label: `${label}.light-vertices`,
  });
  lightBuffer.write(initialMesh.vertices);
  const lightGeometry = {
    vertexBuffers: [lightBuffer.gpu],
    vertexBufferLayouts: [
      {
        arrayStride: LIGHT_VERTEX_STRIDE,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x2" as const },
          { shaderLocation: 1, offset: 8, format: "float32" as const },
          { shaderLocation: 2, offset: 12, format: "float32" as const },
          { shaderLocation: 3, offset: 16, format: "float32" as const },
          { shaderLocation: 4, offset: 20, format: "float32" as const },
        ],
      },
    ],
    vertexCount: lightVertexCount(),
  };
  const prism = prismGeometry(gpu, `${label}.prism`);
  const prismWireframe = prismWireframeGeometry(
    gpu,
    `${label}.prism-wireframe`
  );
  return {
    gpu,
    outputSize: output,
    light: draw(gpu, {
      shader: lightWgsl,
      geometry: lightGeometry,
      blend: "additive",
      cull: "none",
      depth: false,
      label: `${label}.light`,
    }),
    lightBuffer,
    lightStats: initialMesh.stats,
    wall: draw(gpu, {
      shader: wallWgsl,
      vertices: 6,
      cull: "back",
      depth: false,
      label: `${label}.wall`,
    }),
    copyToBack: effect(gpu, copyLinearWgsl, { label: `${label}.copy-to-back` }),
    copyToFront: effect(gpu, copyLinearWgsl, {
      label: `${label}.copy-to-front`,
    }),
    bloomDownsample: [
      effect(gpu, bloomWgsl, { label: `${label}.bloom-half` }),
      effect(gpu, bloomWgsl, { label: `${label}.bloom-quarter` }),
      effect(gpu, bloomWgsl, { label: `${label}.bloom-eighth` }),
      effect(gpu, bloomWgsl, { label: `${label}.bloom-sixteenth` }),
    ],
    bloomUpsample: [
      effect(gpu, bloomUpsampleWgsl, {
        label: `${label}.bloom-upsample-eighth`,
        blend: "additive",
      }),
      effect(gpu, bloomUpsampleWgsl, {
        label: `${label}.bloom-upsample-quarter`,
        blend: "additive",
      }),
      effect(gpu, bloomUpsampleWgsl, {
        label: `${label}.bloom-upsample-half`,
        blend: "additive",
      }),
    ],
    present: effect(gpu, presentWgsl, { label: `${label}.present` }),
    glassBack: draw(gpu, {
      shader: glassBackWgsl,
      geometry: prism,
      cull: "front",
      depth: false,
      label: `${label}.glass-back`,
    }),
    glassFront: draw(gpu, {
      shader: glassWgsl,
      geometry: prism,
      cull: "back",
      depth: false,
      label: `${label}.glass-front`,
    }),
    wireframe: draw(gpu, {
      shader: wireframeWgsl,
      geometry: prismWireframe,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.wireframe`,
    }),
    lightWireframe: draw(gpu, {
      shader: lightWireframeWgsl,
      geometry: lightGeometry,
      cull: "none",
      depth: false,
      blend: "premultiplied",
      label: `${label}.light-wireframe`,
    }),
    prism,
    prismWireframe,
    sceneSampler: sampler(gpu, {
      minFilter: "linear",
      magFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    }),
    controls: {
      ...DEFAULT_PRISM_CONTROLS,
      spectralDispersion:
        DEFAULT_PRISM_CONTROLS.spectralDispersion ??
        PRISM_DISPERSION_PRESETS[DEFAULT_PRISM_CONTROLS.dispersion],
    },
    lampArc: PRISM_DEFAULT_ARC,
    lampTarget: 0.5,
    orbit: [0, 0],
    aspect,
    view: cameraView(
      aspect,
      0,
      0,
      DEFAULT_PRISM_CONTROLS.cameraDistance,
      DEFAULT_PRISM_CONTROLS.cameraFov
    ),
    label,
  };
}

function refreshCamera(scene: PrismScene): void {
  scene.view = cameraView(
    scene.aspect,
    scene.orbit[0],
    scene.orbit[1],
    scene.controls.cameraDistance,
    scene.controls.cameraFov
  );
}

function refreshLightMesh(scene: PrismScene): void {
  const mesh = buildLightMesh({
    light: lampAt(scene.lampArc, scene.controls.beamWidth, scene.lampTarget),
    dispersion:
      scene.controls.spectralDispersion ??
      PRISM_DISPERSION_PRESETS[scene.controls.dispersion],
    edgeFalloff: scene.controls.lightFade.edgeFalloff,
    wallHalfExtent: wallExtent(
      scene.aspect,
      scene.controls.cameraDistance,
      scene.controls.cameraFov
    ),
  });
  scene.lightBuffer.write(mesh.vertices);
  scene.lightStats = mesh.stats;
}

export function setControls(scene: PrismScene, controls: PrismControls): void {
  const defaultGlass = DEFAULT_PRISM_CONTROLS.glass;
  const defaultPostprocess = DEFAULT_PRISM_CONTROLS.postprocess;
  const defaultLightFade = DEFAULT_PRISM_CONTROLS.lightFade;
  const inputGlass = controls.glass ?? defaultGlass;
  const inputPostprocess = controls.postprocess ?? defaultPostprocess;
  const inputLightFade = controls.lightFade ?? defaultLightFade;
  const inputSpectralDispersion =
    controls.spectralDispersion ??
    PRISM_DISPERSION_PRESETS[
      controls.dispersion ?? DEFAULT_PRISM_CONTROLS.dispersion
    ];
  const inputAbsorption = inputGlass.absorption ?? defaultGlass.absorption;
  const finite = (value: number | undefined, fallback: number) =>
    typeof value === "number" && Number.isFinite(value) ? value : fallback;
  const next = {
    ...controls,
    // Runtime fallback keeps Fast Refresh safe across the control schema change.
    cameraDistance: clampCameraDistance(
      controls.cameraDistance ?? DEFAULT_PRISM_CONTROLS.cameraDistance
    ),
    cameraFov: clampCameraFov(
      controls.cameraFov ?? DEFAULT_PRISM_CONTROLS.cameraFov
    ),
    beamWidth: clampBeamWidth(
      controls.beamWidth ?? DEFAULT_PRISM_CONTROLS.beamWidth
    ),
    spectralDispersion: {
      base: Math.min(
        PRISM_SPECTRAL_DISPERSION_RANGES.base.max,
        Math.max(
          PRISM_SPECTRAL_DISPERSION_RANGES.base.min,
          finite(
            inputSpectralDispersion.base,
            PRISM_DISPERSION_PRESETS[DEFAULT_PRISM_CONTROLS.dispersion].base
          )
        )
      ),
      strength: Math.min(
        PRISM_SPECTRAL_DISPERSION_RANGES.strength.max,
        Math.max(
          PRISM_SPECTRAL_DISPERSION_RANGES.strength.min,
          finite(
            inputSpectralDispersion.strength,
            PRISM_DISPERSION_PRESETS[DEFAULT_PRISM_CONTROLS.dispersion].strength
          )
        )
      ),
    },
    lightFade: {
      edgeFalloff: Math.min(
        PRISM_LIGHT_FADE_RANGES.edgeFalloff.max,
        Math.max(
          PRISM_LIGHT_FADE_RANGES.edgeFalloff.min,
          finite(inputLightFade.edgeFalloff, defaultLightFade.edgeFalloff)
        )
      ),
      rainbowFalloff: Math.min(
        PRISM_LIGHT_FADE_RANGES.rainbowFalloff.max,
        Math.max(
          PRISM_LIGHT_FADE_RANGES.rainbowFalloff.min,
          finite(
            inputLightFade.rainbowFalloff,
            defaultLightFade.rainbowFalloff
          )
        )
      ),
    },
    wireframe: controls.wireframe ?? DEFAULT_PRISM_CONTROLS.wireframe,
    lightWireframe:
      controls.lightWireframe ?? DEFAULT_PRISM_CONTROLS.lightWireframe,
    environmentDebug:
      controls.environmentDebug ?? DEFAULT_PRISM_CONTROLS.environmentDebug,
    glass: {
      ior: finite(inputGlass.ior, defaultGlass.ior),
      reflectionStrength: finite(
        inputGlass.reflectionStrength,
        defaultGlass.reflectionStrength
      ),
      absorption: [
        finite(inputAbsorption[0], defaultGlass.absorption[0]),
        finite(inputAbsorption[1], defaultGlass.absorption[1]),
        finite(inputAbsorption[2], defaultGlass.absorption[2]),
      ] as const,
      frostRadius: finite(inputGlass.frostRadius, defaultGlass.frostRadius),
      dispersion: finite(inputGlass.dispersion, defaultGlass.dispersion),
      iridescenceStrength: finite(
        inputGlass.iridescenceStrength,
        defaultGlass.iridescenceStrength
      ),
      iridescenceFrequency: finite(
        inputGlass.iridescenceFrequency,
        defaultGlass.iridescenceFrequency
      ),
      environmentExposure: finite(
        inputGlass.environmentExposure,
        defaultGlass.environmentExposure
      ),
    },
    postprocess: {
      bloomStrength: finite(
        inputPostprocess.bloomStrength,
        defaultPostprocess.bloomStrength
      ),
      bloomThreshold: finite(
        inputPostprocess.bloomThreshold,
        defaultPostprocess.bloomThreshold
      ),
      bloomRadius: finite(
        inputPostprocess.bloomRadius,
        defaultPostprocess.bloomRadius
      ),
    },
  };
  const opticsChanged =
    next.dispersion !== scene.controls.dispersion ||
    next.spectralDispersion.base !== scene.controls.spectralDispersion?.base ||
    next.spectralDispersion.strength !==
      scene.controls.spectralDispersion?.strength ||
    next.beamWidth !== scene.controls.beamWidth ||
    next.lightFade.edgeFalloff !== scene.controls.lightFade.edgeFalloff;
  const cameraChanged =
    next.cameraDistance !== scene.controls.cameraDistance ||
    next.cameraFov !== scene.controls.cameraFov;
  scene.controls = next;
  if (cameraChanged) refreshCamera(scene);
  if (opticsChanged || cameraChanged) refreshLightMesh(scene);
}

export function setLampArc(scene: PrismScene, position: number): void {
  setLampAim(scene, position, scene.lampTarget);
}

export function setLampAim(
  scene: PrismScene,
  arcPosition: number,
  targetPosition: number
): void {
  const nextArc = Math.min(1, Math.max(0, arcPosition));
  const nextTarget = Math.min(1, Math.max(0, targetPosition));
  if (nextArc === scene.lampArc && nextTarget === scene.lampTarget) return;
  scene.lampArc = nextArc;
  scene.lampTarget = nextTarget;
  refreshLightMesh(scene);
}

export function setOrbit(scene: PrismScene, x: number, y: number): void {
  scene.orbit = [Math.min(1, Math.max(-1, x)), Math.min(1, Math.max(-1, y))];
  refreshCamera(scene);
}

export function resizeScene(
  scene: PrismScene,
  output: readonly [number, number]
): void {
  scene.outputSize = output;
  scene.aspect = output[0] / Math.max(1, output[1]);
  scene.sceneTargets?.[0].resize(output);
  scene.sceneTargets?.[1].resize(output);
  scene.bloomTargets?.forEach((bloomTarget, level) => {
    bloomTarget.resize(bloomLevelSize(output, level));
  });
  refreshCamera(scene);
  refreshLightMesh(scene);
}

export function incidenceAt(position: number): number {
  const clamped = Math.min(1, Math.max(0, position));
  return (
    PRISM_INCIDENCE_ARC.min +
    (PRISM_INCIDENCE_ARC.max - PRISM_INCIDENCE_ARC.min) * clamped
  );
}

export function lampAt(
  position: number,
  beamWidth = DEFAULT_PRISM_CONTROLS.beamWidth,
  targetPosition = 0.5
): CollimatedLight {
  return lampForIncidence(incidenceAt(position), beamWidth, targetPosition);
}

export function wallExtent(
  aspect: number,
  cameraDistance = DEFAULT_PRISM_CONTROLS.cameraDistance,
  cameraFov = DEFAULT_PRISM_CONTROLS.cameraFov
): readonly [number, number] {
  const halfHeight = wallHalfHeight(aspect, cameraDistance, cameraFov);
  return [halfHeight * aspect, halfHeight];
}

/** Kept as one shared block so wall, ribbons and glass cannot drift apart. */
export function sceneUniforms(scene: PrismScene): Record<string, unknown> {
  const wallColor = scene.controls.wallColor.match(
    /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i
  );
  return {
    viewProjection: scene.view.camera.viewProjection,
    wallHalfExtent: wallExtent(
      scene.aspect,
      scene.controls.cameraDistance,
      scene.controls.cameraFov
    ),
    wallColor: wallColor
      ? wallColor.slice(1).map((channel) => Number.parseInt(channel, 16) / 255)
      : [0, 0, 0],
    causticOnly: scene.controls.view === "caustic" ? 1 : 0,
    lightPlaneZ: PRISM_LIGHT_PLANE_Z,
    lightWhiteQuads: LIGHT_WHITE_QUADS,
    lightBeamSlices: PRISM_BEAM_SLICES,
    lightEdgeFalloff: scene.controls.lightFade.edgeFalloff,
    rainbowFalloff: scene.controls.lightFade.rainbowFalloff,
  };
}

export function glassUniforms(scene: PrismScene): Record<string, unknown> {
  const glass = scene.controls.glass;
  return {
    viewProjection: scene.view.camera.viewProjection,
    environmentRotation: ENVIRONMENT_ROTATION,
    cameraPosition: scene.view.position,
    absorption: glass.absorption,
    prismA: PRISM_TRIANGLE.a,
    prismB: PRISM_TRIANGLE.b,
    prismC: PRISM_TRIANGLE.c,
    resolution: scene.outputSize,
    frontZ: PRISM_FRONT_Z,
    backZ: PRISM_BACK_Z,
    wallZ: 0,
    ior: glass.ior,
    reflectionStrength: glass.reflectionStrength,
    frostRadius: glass.frostRadius,
    dispersion: glass.dispersion,
    iridescenceStrength: glass.iridescenceStrength,
    iridescenceFrequency: glass.iridescenceFrequency,
    environmentExposure: glass.environmentExposure,
  };
}

export async function prepareScene(
  scene: PrismScene,
  output: Output
): Promise<void> {
  scene.outputSize = output.size;
  scene.aspect = output.size[0] / Math.max(1, output.size[1]);
  refreshCamera(scene);
  refreshLightMesh(scene);
  const readTarget =
    scene.sceneTargets?.[0] ??
    target(scene.gpu, {
      size: output.size,
      format: "rgba16float",
      label: `${scene.label}.scene-a`,
    });
  const writeTarget =
    scene.sceneTargets?.[1] ??
    target(scene.gpu, {
      size: output.size,
      format: "rgba16float",
      label: `${scene.label}.scene-b`,
    });
  scene.sceneTargets = [readTarget, writeTarget];
  if (
    readTarget.size[0] !== output.size[0] ||
    readTarget.size[1] !== output.size[1]
  ) {
    readTarget.resize(output.size);
  }
  if (
    writeTarget.size[0] !== output.size[0] ||
    writeTarget.size[1] !== output.size[1]
  ) {
    writeTarget.resize(output.size);
  }
  const bloomTargets =
    scene.bloomTargets ??
    (Array.from({ length: BLOOM_LEVELS }, (_, level) =>
      target(scene.gpu, {
        size: bloomLevelSize(output.size, level),
        format: "rgba16float",
        label: `${scene.label}.bloom-${level}`,
      })
    ) as unknown as BloomTargets);
  scene.bloomTargets = bloomTargets;
  bloomTargets.forEach((bloomTarget, level) => {
    const size = bloomLevelSize(output.size, level);
    if (bloomTarget.size[0] !== size[0] || bloomTarget.size[1] !== size[1]) {
      bloomTarget.resize(size);
    }
  });
  bind(scene, readTarget, writeTarget, bloomTargets);
  const outputSignature = { colors: [output.format] } as const;
  await Promise.all([
    scene.light.compile(readTarget),
    scene.wall.compile(readTarget),
    scene.copyToBack.compile(writeTarget),
    scene.glassBack.compile(writeTarget),
    scene.copyToFront.compile(readTarget),
    scene.glassFront.compile(readTarget),
    scene.wireframe.compile(readTarget),
    scene.lightWireframe.compile(readTarget),
    ...scene.bloomDownsample.map((bloom, level) =>
      bloom.compile(bloomTargets[level]!)
    ),
    ...scene.bloomUpsample.map((bloom, index) =>
      bloom.compile(bloomTargets[2 - index]!)
    ),
    scene.present.compile(outputSignature),
  ]);
}

export function presentScene(
  scene: PrismScene,
  output: Output,
  currentFrame?: Frame
): void {
  const readTarget = scene.sceneTargets?.[0];
  const writeTarget = scene.sceneTargets?.[1];
  const bloomTargets = scene.bloomTargets;
  if (!readTarget || !writeTarget || !bloomTargets) {
    throw new Error("prepareScene must run before presentScene.");
  }
  bind(scene, readTarget, writeTarget, bloomTargets);
  const encode = (current: Frame) => {
    const showBackFace =
      scene.controls.view === "glass" || scene.controls.view === "back";
    const showLightOnly = scene.controls.view === "caustic";
    current.pass({ target: readTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(scene.wall);
      if (showLightOnly) {
        pass.draw(scene.light);
        if (scene.controls.lightWireframe) pass.draw(scene.lightWireframe);
      }
    });
    current.pass({ target: writeTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(scene.copyToBack);
      if (showBackFace) pass.draw(scene.glassBack);
      if (showBackFace) {
        pass.draw(scene.light);
        if (scene.controls.lightWireframe) pass.draw(scene.lightWireframe);
      }
    });
    current.pass({ target: readTarget, clear: [0, 0, 0, 1] }, (pass) => {
      pass.draw(scene.copyToFront);
      if (scene.controls.view === "glass") {
        pass.draw(scene.glassFront);
        if (scene.controls.wireframe) pass.draw(scene.wireframe);
      }
    });
    bloomTargets.forEach((bloomTarget, level) => {
      current.pass({ target: bloomTarget, clear: [0, 0, 0, 1] }, (pass) => {
        pass.draw(scene.bloomDownsample[level]!);
      });
    });
    scene.bloomUpsample.forEach((bloom, index) => {
      current.pass(
        { target: bloomTargets[2 - index]!, clear: false },
        (pass) => {
          pass.draw(bloom);
        }
      );
    });
    current.pass({ target: output }, (pass) => {
      pass.draw(scene.present);
    });
  };
  if (currentFrame) encode(currentFrame);
  else frame(scene.gpu, encode);
}

function bind(
  scene: PrismScene,
  readTarget: Target,
  writeTarget: Target,
  bloomTargets: BloomTargets
): void {
  const values = sceneUniforms(scene);
  scene.light.set({ scene: values });
  scene.lightWireframe.set({ scene: values });
  scene.wall.set({ scene: values });
  scene.copyToBack.set({ sceneTexture: readTarget });
  scene.glassBack.set({
    params: glassUniforms(scene),
    sceneTexture: readTarget,
    sceneSampler: scene.sceneSampler,
  });
  scene.copyToFront.set({ sceneTexture: writeTarget });
  scene.glassFront.set({
    params: glassUniforms(scene),
    sceneTexture: writeTarget,
    sceneSampler: scene.sceneSampler,
  });
  scene.wireframe.set({
    params: { viewProjection: scene.view.camera.viewProjection },
  });
  scene.bloomDownsample.forEach((bloom, level) => {
    const source = level === 0 ? readTarget : bloomTargets[level - 1]!;
    bloom.set({
      sourceTexture: source,
      sourceSampler: scene.sceneSampler,
      params: {
        sourceTexelSize: [1 / source.size[0], 1 / source.size[1]],
        threshold: scene.controls.postprocess.bloomThreshold,
        extractHighlights: level === 0 ? 1 : 0,
      },
    });
  });
  scene.bloomUpsample.forEach((bloom, index) => {
    const source = bloomTargets[3 - index]!;
    bloom.set({
      sourceTexture: source,
      sourceSampler: scene.sceneSampler,
      params: {
        sourceTexelSize: [1 / source.size[0], 1 / source.size[1]],
        radius: scene.controls.postprocess.bloomRadius,
        scatter: 0.65,
      },
    });
  });
  scene.present.set({
    sceneTexture: readTarget,
    bloomTexture: bloomTargets[0],
    bloomSampler: scene.sceneSampler,
    params: {
      bloomStrength:
        scene.controls.view === "glass"
          ? scene.controls.postprocess.bloomStrength
          : 0,
    },
  });
}

function bloomLevelSize(
  size: readonly [number, number],
  level: number
): readonly [number, number] {
  const divisor = 2 ** (level + 1);
  return [
    Math.max(1, Math.ceil(size[0] / divisor)),
    Math.max(1, Math.ceil(size[1] / divisor)),
  ];
}

function destroyTarget(value: Target | undefined): void {
  (value as (Target & { destroy?: () => void }) | undefined)?.destroy?.();
}

export function destroyScene(scene: PrismScene): void {
  destroyTarget(scene.sceneTargets?.[0]);
  destroyTarget(scene.sceneTargets?.[1]);
  scene.sceneTargets = undefined;
  scene.bloomTargets?.forEach(destroyTarget);
  scene.bloomTargets = undefined;
  scene.lightBuffer.destroy();
  scene.prism.destroy();
  scene.prismWireframe.destroy();
}
