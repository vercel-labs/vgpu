import { HIGH_LIGHT_MESH_LAYOUT, type LightMeshLayout } from "../scene/light-mesh";
import type {
  PrismDebugSource,
  PrismPipelineMode,
  PrismPipelineQuality,
} from "../pipelines/types";
import { LOW_DARK_BLOOM_STRENGTH } from "../pipelines/quality";

export const PRISM_DEBUG_SOURCE_IDS = [
  "wall-material",
  "wall-lighting",
  "wall-normal",
  "wall-roughness",
  "global-shadow",
  "prism-ao",
  "raw-caustic",
  "studio-environment",
  "spectral-light-mesh",
  "prism-mesh",
  "shadow-geometry",
  "composed-wall",
  "prism-shadow",
  "projected-caustic",
  "back-glass",
  "internal-caustic",
  "light-backdrop-pass",
  "backdrop-hdr",
  "copy-backdrop",
  "front-glass",
  "glass-accent",
  "light-scene-pass",
  "scene-hdr",
  "light-present-pass",
  "final-output",
] as const;

export const PRISM_DARK_DEBUG_SOURCE_IDS = [
  "dark-wall",
  "dark-studio-environment",
  "dark-spectral-light-mesh",
  "dark-prism-mesh",
  "dark-external-light",
  "dark-back-glass",
  "dark-internal-light",
  "dark-backdrop-pass",
  "dark-backdrop-hdr",
  "dark-copy-backdrop",
  "dark-front-glass",
  "dark-scene-pass",
  "dark-scene-hdr",
  "dark-bloom-0",
  "dark-bloom-1",
  "dark-bloom-2",
  "dark-particle-light",
  "dark-bloom-composite",
  "dark-present-cache-pass",
  "dark-presentation-ldr",
  "dark-presentation-copy",
  "dark-dust",
  "dark-output-pass",
  "dark-final-output",
] as const;

export type PrismDebugSourceId =
  | (typeof PRISM_DEBUG_SOURCE_IDS)[number]
  | (typeof PRISM_DARK_DEBUG_SOURCE_IDS)[number];

export interface PrismDebugTargetFacts {
  readonly format: string;
  readonly sampleCount: number;
}

export interface LightDebugPipelineFacts {
  readonly quality?: PrismPipelineQuality;
  readonly lightMeshLayout?: LightMeshLayout;
  readonly backdrop?: PrismDebugTargetFacts;
  readonly scene?: PrismDebugTargetFacts;
  readonly outputFormat?: string;
}

export interface DarkDebugPipelineFacts {
  readonly quality?: PrismPipelineQuality;
  readonly lightMeshLayout?: LightMeshLayout;
  readonly backdrop?: PrismDebugTargetFacts;
  readonly scene?: PrismDebugTargetFacts;
  readonly bloom?: readonly PrismDebugTargetFacts[];
  readonly presentation?: PrismDebugTargetFacts;
  readonly outputFormat?: string;
}

const DEFAULT_LIGHT_BACKDROP_TARGET = {
  format: "rgba16float",
  sampleCount: 1,
} as const;
const DEFAULT_LIGHT_SCENE_TARGET = {
  format: "rgba16float",
  sampleCount: 4,
} as const;

export function createLightDebugSources(
  facts: LightDebugPipelineFacts = {}
): readonly PrismDebugSource[] {
  const quality = facts.quality ?? "high";
  const mesh = facts.lightMeshLayout ?? HIGH_LIGHT_MESH_LAYOUT;
  const backdrop = facts.backdrop ?? DEFAULT_LIGHT_BACKDROP_TARGET;
  const scene = facts.scene ?? DEFAULT_LIGHT_SCENE_TARGET;
  return [
    source(
      "wall-material",
      "Wall material",
      "asset",
      "srgb",
      [],
      [detail("Texture", "512×512 · albedo / normal / roughness")]
    ),
    source(
      "wall-lighting",
      "Wall lighting mask",
      "asset",
      "none",
      [],
      [detail("Texture", "512×512 · global light / contact AO")]
    ),
    source("wall-normal", "Wall normal · inspection", "view", "normal", [
      input("wall-material", "decode GB"),
    ]),
    source("wall-roughness", "Wall roughness · inspection", "view", "scalar", [
      input("wall-material", "decode A"),
    ]),
    source("global-shadow", "Global light · inspection", "view", "scalar", [
      input("wall-lighting", "decode R"),
    ]),
    source("prism-ao", "Contact AO · inspection", "view", "scalar", [
      input("wall-lighting", "decode GB"),
    ]),
    source(
      "raw-caustic",
      "Caustic profile LUT",
      "asset",
      "hdr",
      [],
      [detail("Texture", "1024×256 · distance × wavelength")]
    ),
    source(
      "studio-environment",
      "Studio environment",
      "asset",
      "none",
      [],
      [detail("Resource", "mipmapped equirectangular HDR")]
    ),
    source(
      "spectral-light-mesh",
      "Spectral light mesh",
      "geometry",
      "none",
      [],
      [
        detail(
          "Geometry",
          `${mesh.vertexCount.toLocaleString("en-US")} vertices`
        ),
        detail(
          "Sampling",
          `${mesh.samples} wavelengths × ${mesh.beamSlices} beam slices`
        ),
      ]
    ),
    source(
      "prism-mesh",
      "Prism mesh",
      "geometry",
      "none",
      [],
      [detail("Usage", "front and back glass faces")]
    ),
    source(
      "shadow-geometry",
      "Prism shadow mesh",
      "geometry",
      "none",
      [],
      [detail("Usage", "analytic core and penumbra")]
    ),
    source(
      "composed-wall",
      "Wall draw",
      "draw",
      "hdr",
      quality === "low"
        ? [
            input("wall-material", "sample GB normal"),
            input("wall-lighting", "sample lighting + contact AO"),
          ]
        : [
            input("wall-material", "sample material"),
            input("wall-lighting", "sample lighting mask"),
          ],
      [
        detail(
          "Shader",
          quality === "low"
            ? "pipelines/light/passes/wall/wall-low.wgsl"
            : "pipelines/light/passes/wall/wall.wgsl"
        ),
        detail(
          "Material",
          quality === "low"
            ? "flat albedo + large normal · no micro-normal / roughness / specular"
            : "albedo + dual-scale normals + roughness + specular"
        ),
        detail("Coverage", "full screen"),
      ]
    ),
    source(
      "prism-shadow",
      "Prism shadow draw",
      "draw",
      "scalar",
      [input("shadow-geometry", "rasterize")],
      [
        detail("Shader", "pipelines/light/passes/shadow/shadow.wgsl"),
        detail("Blend", "premultiplied"),
      ]
    ),
    source(
      "projected-caustic",
      "Exterior caustic draws",
      "draw",
      "hdr",
      [
        input("spectral-light-mesh", "white + outgoing spans"),
        input("raw-caustic", "sample profile"),
        input("wall-material", "modulate by wall normal"),
      ],
      [
        detail("Shader", "pipelines/light/passes/caustic/caustic.wgsl"),
        detail("Draws", "2 · white beam + outgoing spectrum"),
        detail("Blend", "additive"),
      ]
    ),
    source(
      "back-glass",
      "Back glass draw",
      "draw",
      "none",
      [
        input("prism-mesh", "back faces"),
        input("studio-environment", "reflect"),
      ],
      [
        detail("Shader", "pipelines/shared/glass/glass-back.wgsl"),
        detail("Blend", "premultiplied"),
      ]
    ),
    source(
      "internal-caustic",
      "Internal caustic draw",
      "draw",
      "none",
      [
        input("spectral-light-mesh", "internal span"),
        input("raw-caustic", "sample profile"),
        input("wall-material", "modulate by wall normal"),
      ],
      [
        detail("Shader", "same caustic pipeline"),
        detail("Draws", "1 · internal spectrum"),
        detail("Blend", "additive"),
      ]
    ),
    source(
      "light-backdrop-pass",
      "Backdrop render pass",
      "pass",
      "none",
      [
        input("composed-wall", "1 · draw wall"),
        input("prism-shadow", "2 · draw cast shadow"),
        input("projected-caustic", "3–4 · draw exterior light"),
        input("back-glass", "5 · draw back faces"),
        input("internal-caustic", "6 · draw internal light"),
      ],
      [
        detail("GPU pass", "light.backdrop"),
        detail("Encoding", "1 render bundle · 6 draws"),
        detail("Load", "clear [0, 0, 0, 1]"),
      ]
    ),
    source(
      "backdrop-hdr",
      "Backdrop HDR target",
      "target",
      "hdr",
      [input("light-backdrop-pass", targetWrite(backdrop))],
      targetDetails(backdrop, "full render resolution")
    ),
    source(
      "copy-backdrop",
      "Backdrop copy draw",
      "draw",
      "none",
      [input("backdrop-hdr", "texture read")],
      [
        detail("Shader", "pipelines/shared/presentation/copy-linear.wgsl"),
        detail("Coverage", "full screen"),
      ]
    ),
    source(
      "front-glass",
      "Front glass draw",
      "draw",
      "hdr",
      [
        input("backdrop-hdr", "refract background"),
        input("prism-mesh", "front faces"),
        input("studio-environment", "reflect"),
      ],
      [
        detail("Shader", "pipelines/shared/glass/glass.wgsl"),
        detail("Blend", "replace"),
      ]
    ),
    source(
      "glass-accent",
      "Glass accent draw",
      "draw",
      "none",
      [
        input("prism-mesh", "front faces"),
        input("studio-environment", "reflect"),
      ],
      [
        detail(
          "Shader",
          "pipelines/light/passes/glass-accent/glass-accent.wgsl"
        ),
        detail("Blend", "premultiplied"),
      ]
    ),
    source(
      "light-scene-pass",
      "Scene render pass",
      "pass",
      "none",
      [
        input("copy-backdrop", "1 · copy backdrop"),
        input("front-glass", "2 · draw front glass"),
        input("glass-accent", "3 · draw accent"),
      ],
      [
        detail("GPU pass", "light.scene"),
        detail("Draws", "3"),
        detail("Load", "clear [0, 0, 0, 1]"),
      ]
    ),
    source(
      "scene-hdr",
      "Scene HDR target",
      "target",
      "hdr",
      [input("light-scene-pass", targetWrite(scene))],
      targetDetails(scene, "full render resolution")
    ),
    source(
      "light-present-pass",
      "Presentation render pass",
      "pass",
      "none",
      [input("scene-hdr", "textureLoad")],
      [
        detail("GPU pass", "light.present"),
        detail("Draws", "1 · tone map + linear→sRGB"),
      ]
    ),
    source(
      "final-output",
      "Canvas output",
      "output",
      "srgb",
      [input("light-present-pass", "store color")],
      [
        detail("Format", facts.outputFormat ?? "canvas format"),
        detail("Resolution", "full canvas resolution"),
        detail("Samples", "1×"),
      ]
    ),
  ];
}

const DEFAULT_DARK_BACKDROP_TARGET = {
  format: "rgba16float",
  sampleCount: 1,
} as const;
const DEFAULT_DARK_SCENE_TARGET = {
  format: "rgba16float",
  sampleCount: 4,
} as const;
const DEFAULT_BLOOM_TARGETS = [
  { format: "device-selected HDR", sampleCount: 1 },
  { format: "device-selected HDR", sampleCount: 1 },
  { format: "device-selected HDR", sampleCount: 1 },
  { format: "rgba16float", sampleCount: 1 },
] as const;

export function createDarkDebugSources(
  facts: DarkDebugPipelineFacts = {}
): readonly PrismDebugSource[] {
  const quality = facts.quality ?? "high";
  const lowQuality = quality === "low";
  const mesh = facts.lightMeshLayout ?? HIGH_LIGHT_MESH_LAYOUT;
  const backdrop = facts.backdrop ?? DEFAULT_DARK_BACKDROP_TARGET;
  const scene = facts.scene ?? DEFAULT_DARK_SCENE_TARGET;
  const bloom =
    facts.bloom ??
    (lowQuality ? DEFAULT_BLOOM_TARGETS.slice(0, 2) : DEFAULT_BLOOM_TARGETS);
  const presentation = facts.presentation ?? {
    format: facts.outputFormat ?? "canvas format",
    sampleCount: 1,
  };
  return [
    source(
      "dark-wall",
      "Backdrop clear color",
      "state",
      "none",
      [],
      [detail("Operation", "render-pass clear · no wall draw")]
    ),
    source(
      "dark-studio-environment",
      "Studio environment",
      "asset",
      "none",
      [],
      [detail("Resource", "mipmapped equirectangular HDR")]
    ),
    source(
      "dark-spectral-light-mesh",
      "Spectral light mesh",
      "geometry",
      "none",
      [],
      [
        detail(
          "Geometry",
          `${mesh.vertexCount.toLocaleString("en-US")} vertices`
        ),
        detail(
          "Sampling",
          `${mesh.samples} wavelengths × ${mesh.beamSlices} beam slices`
        ),
      ]
    ),
    source(
      "dark-prism-mesh",
      "Prism mesh",
      "geometry",
      "none",
      [],
      [detail("Usage", "front and back glass faces")]
    ),
    source(
      "dark-external-light",
      "Exterior light draws",
      "draw",
      "none",
      [input("dark-spectral-light-mesh", "white + outgoing spans")],
      [
        detail("Shader", "pipelines/dark/passes/light/light.wgsl"),
        detail("Draws", "2 · white beam + outgoing spectrum"),
        detail("Blend", "additive"),
      ]
    ),
    source(
      "dark-back-glass",
      "Back glass draw",
      "draw",
      "none",
      [
        input("dark-prism-mesh", "back faces"),
        input("dark-studio-environment", "reflect"),
      ],
      [
        detail("Shader", "pipelines/shared/glass/glass-back.wgsl"),
        detail("Blend", "premultiplied"),
      ]
    ),
    source(
      "dark-internal-light",
      "Internal light draw",
      "draw",
      "none",
      [input("dark-spectral-light-mesh", "internal span")],
      [
        detail("Shader", "same light pipeline"),
        detail("Draws", "1 · internal spectrum"),
        detail("Blend", "additive"),
      ]
    ),
    source(
      "dark-backdrop-pass",
      "Backdrop render pass",
      "pass",
      "none",
      [
        input("dark-wall", "clear attachment"),
        input("dark-external-light", "1–2 · draw exterior light"),
        input("dark-back-glass", "3 · draw back faces"),
        input("dark-internal-light", "4 · draw internal light"),
      ],
      [
        detail("GPU pass", "dark.backdrop"),
        detail("Encoding", "1 render bundle · 4 draws"),
      ]
    ),
    source(
      "dark-backdrop-hdr",
      "Backdrop HDR target",
      "target",
      "hdr",
      [input("dark-backdrop-pass", targetWrite(backdrop))],
      targetDetails(backdrop, "full render resolution")
    ),
    source(
      "dark-copy-backdrop",
      "Backdrop copy draw",
      "draw",
      "none",
      [input("dark-backdrop-hdr", "texture read")],
      [
        detail("Shader", "pipelines/shared/presentation/copy-linear.wgsl"),
        detail("Coverage", "full screen"),
      ]
    ),
    source(
      "dark-front-glass",
      "Front glass draw",
      "draw",
      "hdr",
      [
        input("dark-backdrop-hdr", "refract background"),
        input("dark-prism-mesh", "front faces"),
        input("dark-studio-environment", "reflect"),
      ],
      [
        detail("Shader", "pipelines/shared/glass/glass.wgsl"),
        detail("Blend", "replace"),
      ]
    ),
    source(
      "dark-scene-pass",
      "Scene render pass",
      "pass",
      "none",
      [
        input("dark-copy-backdrop", "1 · copy backdrop"),
        input("dark-front-glass", "2 · draw front glass"),
      ],
      [
        detail("GPU pass", "dark.scene"),
        detail("Draws", "2"),
        detail("Load", "clear [0, 0, 0, 1]"),
      ]
    ),
    source(
      "dark-scene-hdr",
      "Scene HDR target",
      "target",
      "hdr",
      [input("dark-scene-pass", targetWrite(scene))],
      targetDetails(scene, "full render resolution")
    ),
    bloomStage(
      "dark-bloom-0",
      "Bloom 1/2",
      "dark-scene-hdr",
      "extract + horizontal blur + vertical blur",
      bloom[0] ?? DEFAULT_BLOOM_TARGETS[0],
      "1/2 render resolution"
    ),
    bloomStage(
      "dark-bloom-1",
      "Bloom 1/4",
      "dark-bloom-0",
      "horizontal downsample/blur + vertical blur",
      bloom[1] ?? DEFAULT_BLOOM_TARGETS[1],
      "1/4 render resolution"
    ),
    ...(lowQuality
      ? []
      : [
          bloomStage(
            "dark-bloom-2",
            "Bloom 1/8",
            "dark-bloom-1",
            "horizontal downsample/blur + vertical blur",
            bloom[2] ?? DEFAULT_BLOOM_TARGETS[2],
            "1/8 render resolution"
          ),
          source(
            "dark-particle-light",
            "Particle light 1/16",
            "target",
            "hdr",
            [input("dark-scene-hdr", "8×8 downsample + H/V blur")],
            [
              ...targetDetails(
                bloom[3] ?? DEFAULT_BLOOM_TARGETS[3],
                "1/16 render resolution"
              ),
              detail("Storage", "2 ping-pong targets"),
              detail("GPU passes", "3 · downsample + H blur + V blur"),
            ]
          ),
        ]),
    source(
      "dark-bloom-composite",
      "Bloom composite",
      "target",
      "hdr",
      lowQuality
        ? [
            input("dark-bloom-0", "near halo"),
            input("dark-bloom-1", "far halo"),
          ]
        : [
            input("dark-bloom-0", "near halo"),
            input("dark-bloom-1", "medium halo"),
            input("dark-bloom-2", "far halo"),
          ],
      [
        ...targetDetails(
          bloom[0] ?? DEFAULT_BLOOM_TARGETS[0],
          "1/2 render resolution"
        ),
        detail("GPU pass", "dark.bloom.composite"),
        detail("Storage", "reuses Bloom 1/2 horizontal target"),
      ]
    ),
    source(
      "dark-present-cache-pass",
      "Presentation cache pass",
      "pass",
      "none",
      [
        input("dark-scene-hdr", "load HDR scene"),
        input("dark-bloom-composite", "add bloom + tone map"),
      ],
      [
        detail("GPU pass", "dark.present-cache"),
        detail("Draws", "1 · ACES + linear→sRGB"),
        detail(
          "Bloom strength",
          lowQuality
            ? `${LOW_DARK_BLOOM_STRENGTH} · low-quality override`
            : "live postprocess control"
        ),
      ]
    ),
    source(
      "dark-presentation-ldr",
      "Retained presentation target",
      "target",
      "srgb",
      [input("dark-present-cache-pass", "store color")],
      targetDetails(presentation, "full render resolution")
    ),
    source(
      "dark-presentation-copy",
      "Presentation copy draw",
      "draw",
      "none",
      [input("dark-presentation-ldr", "textureLoad")],
      [
        detail(
          "Shader",
          "pipelines/dark/passes/presentation/copy-presentation.wgsl"
        ),
        detail("Coverage", "full screen"),
      ]
    ),
    source(
      "dark-dust",
      "Dust draw",
      "draw",
      "none",
      [
        ...(lowQuality
          ? [input("dark-bloom-1", "particle color + illumination")]
          : [
              input("dark-bloom-1", "particle color"),
              input("dark-particle-light", "particle illumination"),
            ]),
      ],
      [
        detail("Shader", "pipelines/dark/passes/particles/dust.wgsl"),
        detail("Geometry", "2,200 instanced quads"),
        detail("Blend", "additive"),
      ]
    ),
    source(
      "dark-output-pass",
      "Output render pass",
      "pass",
      "none",
      [
        input("dark-presentation-copy", "1 · copy retained base"),
        input("dark-dust", "2 · draw animated dust"),
      ],
      [
        detail("GPU pass", "dark.output"),
        detail("Behavior", "runs while scene cache is retained"),
      ]
    ),
    source(
      "dark-final-output",
      "Canvas output",
      "output",
      "none",
      [input("dark-output-pass", "store color")],
      [
        detail("Format", facts.outputFormat ?? "canvas format"),
        detail("Resolution", "full canvas resolution"),
        detail("Samples", "1×"),
      ]
    ),
  ];
}

export const PRISM_DEBUG_SOURCES = createLightDebugSources();
export const PRISM_DARK_DEBUG_SOURCES = createDarkDebugSources();

export function debugSourcesForMode(
  mode: PrismPipelineMode
): readonly PrismDebugSource[] {
  return mode === "light" ? PRISM_DEBUG_SOURCES : PRISM_DARK_DEBUG_SOURCES;
}

function bloomStage(
  id: "dark-bloom-0" | "dark-bloom-1" | "dark-bloom-2",
  label: string,
  dependency: "dark-scene-hdr" | "dark-bloom-0" | "dark-bloom-1",
  operation: string,
  facts: PrismDebugTargetFacts,
  resolution: string
): PrismDebugSource {
  return source(
    id,
    label,
    "target",
    "hdr",
    [input(dependency, operation)],
    [
      ...targetDetails(facts, resolution),
      detail("Storage", "2 ping-pong targets"),
      detail("GPU passes", id === "dark-bloom-0" ? "3" : "2"),
    ]
  );
}

function targetDetails(
  facts: PrismDebugTargetFacts,
  resolution: string
): NonNullable<PrismDebugSource["details"]> {
  return [
    detail("Format", facts.format),
    detail("Resolution", resolution),
    detail(
      "Samples",
      facts.sampleCount > 1 ? `${facts.sampleCount}× MSAA → resolve` : "1×"
    ),
  ];
}

function targetWrite(facts: PrismDebugTargetFacts): string {
  return facts.sampleCount > 1 ? "MSAA render + resolve" : "store color";
}

function detail(
  label: string,
  value: string
): NonNullable<PrismDebugSource["details"]>[number] {
  return { label, value };
}

function input(
  sourceId: PrismDebugSourceId,
  operation: string
): { readonly source: PrismDebugSourceId; readonly operation: string } {
  return { source: sourceId, operation };
}

function source(
  id: PrismDebugSourceId,
  label: string,
  kind: PrismDebugSource["kind"],
  visualization: PrismDebugSource["visualization"],
  inputs: readonly ReturnType<typeof input>[] = [],
  details?: PrismDebugSource["details"]
): PrismDebugSource {
  return { id, label, kind, inputs, visualization, details };
}
