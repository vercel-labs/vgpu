import type { Target } from "vgpu";

import {
  destroyLightAssetTextures,
  loadLightAssetTextures,
  type LightTextureLoader,
} from "./assets/loader";
import {
  createLightDebugSources,
  PRISM_DEBUG_SOURCES,
} from "../../debug/sources";
import { prepareRuntimeEnvironment } from "../../runtime/resources";
import { resizeRuntime } from "../../runtime/state";
import type { PrismRuntime } from "../../runtime/types";
import { PRISM_LIGHT_TONE_MAPPING_CODES } from "../../types";
import type {
  PrismDebugTargetPreview,
  PrismOutput,
  PrismPipeline,
  PrismPipelineQuality,
} from "../types";
import { bindLightGraph } from "./bind";
import { recordLightBackdropBundle } from "./bundles";
import { createLightGraph, ensureLightWireframeDraws } from "./create-graph";
import { renderLightGraph } from "./render";
import {
  destroyLightTargets,
  ensureLightTargets,
  resizeLightTargets,
} from "./targets";
import type { LightPipelineGraph } from "./types";
import type { LightDebugDraws } from "./debug/draws";

export interface LightPipelineOptions {
  readonly assetLoader?: LightTextureLoader;
  readonly quality?: PrismPipelineQuality;
}

export interface LightPrismPipeline extends PrismPipeline {
  readonly mode: "light";
  readonly targets: {
    readonly backdropHDR?: Target;
    readonly sceneHDR?: Target;
  };
  debugTarget(sourceId: string): PrismDebugTargetPreview | undefined;
  /** Dynamically imports preview shaders; never called by the production path. */
  createDebugDraws(): Promise<LightDebugDraws>;
}

export function createLightPipeline(
  runtime: PrismRuntime,
  options: LightPipelineOptions = {}
): LightPrismPipeline {
  const quality = options.quality ?? "high";
  const graph = createLightGraph(runtime, quality);
  const loader = options.assetLoader;
  let destroyed = false;
  let debugDraws: LightDebugDraws | undefined;
  let debugDrawsPromise: Promise<LightDebugDraws> | undefined;
  let debugSources = PRISM_DEBUG_SOURCES;
  return {
    mode: "light",
    lightMeshLayout: graph.lightMeshLayout,
    get targets() {
      return { backdropHDR: graph.backdropHDR, sceneHDR: graph.sceneHDR };
    },
    async prepare(output) {
      if (destroyed)
        throw new Error("Cannot prepare a destroyed light pipeline.");
      resizeRuntime(runtime, output.size);
      ensureLightTargets(graph, runtime, output.size);
      debugSources = createLightDebugSources({
        quality,
        lightMeshLayout: graph.lightMeshLayout,
        backdrop: graph.backdropHDR,
        scene: graph.sceneHDR,
        outputFormat: output.format,
      });
      ensureLightWireframeDraws(graph, runtime);
      const environmentReady = prepareRuntimeEnvironment(runtime);
      const ownedAssets = graph.assets;
      const assetsReady = ownedAssets
        ? Promise.resolve(ownedAssets)
        : loadLightAssetTextures(runtime.gpu, loader);
      // Pipeline compilation needs only the target signatures, so overlap it
      // with both environment generation and the one-time asset bake.
      const graphReady = Promise.resolve().then(() =>
        Promise.all(compileGraph(graph, output))
      );
      // All branches continue touching the shared GPU after their first
      // await. Do not let one rejection release the runtime underneath its
      // still-running sibling. Asset failure keeps the old sequential error
      // precedence, while an environment failure releases newly-loaded files
      // before it escapes.
      const [assetsResult, environmentResult, graphResult] =
        await Promise.allSettled([assetsReady, environmentReady, graphReady]);
      const loaded =
        assetsResult.status === "fulfilled" ? assetsResult.value : undefined;
      if (destroyed) {
        if (!ownedAssets) destroyLightAssetTextures(loaded);
        return;
      }
      if (assetsResult.status === "rejected") throw assetsResult.reason;
      if (environmentResult.status === "rejected") {
        if (!ownedAssets) destroyLightAssetTextures(loaded);
        throw environmentResult.reason;
      }
      if (graphResult.status === "rejected") {
        if (!ownedAssets) destroyLightAssetTextures(loaded);
        throw graphResult.reason;
      }
      graph.assets = loaded;
      bindLightGraph(graph, runtime);
      if (destroyed) return;
      recordLightBackdropBundle(graph, runtime);
    },
    resize(size) {
      if (destroyed) return;
      resizeLightTargets(graph, size);
    },
    bind(_time, options) {
      if (destroyed) return;
      bindLightGraph(
        graph,
        runtime,
        options?.updateScene ?? true,
        options?.revealProgress ?? 1,
        options?.beamWidthReveal ?? 1
      );
      debugDraws?.bind();
    },
    render(currentFrame, output, renderOptions) {
      renderLightGraph(currentFrame, graph, runtime, output, renderOptions);
    },
    debugSources: () => debugSources,
    debugTarget(sourceId) {
      return resolveLightDebugTarget(graph, runtime, sourceId);
    },
    async createDebugDraws() {
      if (destroyed)
        throw new Error(
          "Cannot create previews for a destroyed light pipeline."
        );
      if (!graph.assets)
        throw new Error(
          "prepare() must load light assets before debug previews."
        );
      debugDrawsPromise ??= import("./debug/draws").then(
        ({ createLightDebugDraws }) => {
          if (destroyed)
            throw new Error(
              "Cannot create previews for a destroyed light pipeline."
            );
          debugDraws = createLightDebugDraws(runtime, graph);
          return debugDraws;
        }
      );
      try {
        return await debugDrawsPromise;
      } catch (error) {
        debugDrawsPromise = undefined;
        throw error;
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      debugDraws = undefined;
      debugDrawsPromise = undefined;
      destroyLightTargets(graph);
      graph.prismShadowGeometry.destroy();
      destroyLightAssetTextures(graph.assets);
      graph.assets = undefined;
    },
  };
}

function resolveLightDebugTarget(
  graph: LightPipelineGraph,
  runtime: PrismRuntime,
  sourceId: string
): PrismDebugTargetPreview | undefined {
  const backdrop = graph.backdropHDR;
  const scene = graph.sceneHDR;
  if (sourceId === "backdrop-hdr" && backdrop) return { primary: backdrop };
  if (sourceId === "scene-hdr" && scene) return { primary: scene };
  if (sourceId === "final-output" && scene)
    return {
      primary: scene,
      exposure: runtime.controls.lightMode.output.exposure,
      toneMapping:
        PRISM_LIGHT_TONE_MAPPING_CODES[
          runtime.controls.lightMode.output.toneMapping
        ],
    };
  if (sourceId === "front-glass" && scene && backdrop) {
    return {
      primary: scene,
      secondary: backdrop,
      mode: "difference",
      differenceGain: 5,
    };
  }
  return undefined;
}

function compileGraph(
  graph: LightPipelineGraph,
  output: PrismOutput
): Promise<unknown>[] {
  const backdrop = graph.backdropHDR!;
  const scene = graph.sceneHDR!;
  const outputSignature = { colors: [output.format] } as const;
  return [
    graph.wall.compile(backdrop),
    graph.prismShadow.compile(backdrop),
    graph.caustic.compile(backdrop),
    graph.glassBack.compile(backdrop),
    ...(graph.lightWireframe ? [graph.lightWireframe.compile(backdrop)] : []),
    graph.copyBackdrop.compile(scene),
    graph.glassFront.compile(scene),
    graph.glassAccent.compile(scene),
    ...(graph.wireframe ? [graph.wireframe.compile(scene)] : []),
    graph.present.compile(outputSignature),
  ];
}

export { LIGHT_TARGET_COUNT } from "./targets";
export {
  LIGHT_CAUSTIC_DEBUG_ENTRY,
  LIGHT_WALL_DEBUG_ENTRIES,
} from "./debug/entries";
