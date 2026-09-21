import type { Target } from "vgpu";

import {
  createDarkDebugSources,
  PRISM_DARK_DEBUG_SOURCES,
} from "../../debug/sources";
import { prepareRuntimeEnvironment } from "../../runtime/resources";
import { settleAllOrThrow } from "../../runtime/settle";
import { resizeRuntime } from "../../runtime/state";
import type { PrismRuntime } from "../../runtime/types";
import type {
  PrismDebugTargetPreview,
  PrismOutput,
  PrismPipeline,
  PrismPipelineQuality,
} from "../types";
import { bindDarkGraph } from "./bind";
import { recordDarkBackdropBundle } from "./bundles";
import { createDarkGraph } from "./create-graph";
import { renderDarkGraph } from "./render";
import {
  destroyDarkTargets,
  ensureDarkTargets,
  resizeDarkTargets,
} from "./targets";
import type { DarkPipelineGraph } from "./types";

export interface DarkPrismPipeline extends PrismPipeline {
  readonly mode: "dark";
  readonly targets: {
    readonly backdropHDR?: Target;
    readonly sceneHDR?: Target;
    readonly presentationLDR?: Target;
  };
  debugTarget(sourceId: string): PrismDebugTargetPreview | undefined;
}

export interface DarkPipelineOptions {
  readonly quality?: PrismPipelineQuality;
}

export function createDarkPipeline(
  runtime: PrismRuntime,
  options: DarkPipelineOptions = {}
): DarkPrismPipeline {
  const quality = options.quality ?? "high";
  const graph = createDarkGraph(runtime, quality);
  let presentationValid = false;
  let boundRevealProgress = 1;
  let debugSources = PRISM_DARK_DEBUG_SOURCES;
  return {
    mode: "dark",
    lightMeshLayout: graph.lightMeshLayout,
    get targets() {
      return {
        backdropHDR: graph.backgroundTarget,
        sceneHDR: graph.sceneTarget,
        presentationLDR: graph.presentationTarget,
      };
    },
    async prepare(output) {
      resizeRuntime(runtime, output.size);
      ensureDarkTargets(graph, runtime, output.size, output.format, quality);
      debugSources = createDarkDebugSources({
        quality,
        lightMeshLayout: graph.lightMeshLayout,
        backdrop: graph.backgroundTarget,
        scene: graph.sceneTarget,
        bloom: graph.bloomTargets?.map(({ vertical }) => vertical),
        presentation: graph.presentationTarget,
        outputFormat: output.format,
      });
      presentationValid = false;
      const environmentReady = prepareRuntimeEnvironment(runtime);
      bindDarkGraph(graph, runtime, 0, true);
      // A cold shader failure must not release the shared runtime while either
      // environment bake is still compiling or submitting work.
      await settleAllOrThrow([
        environmentReady,
        ...compileGraph(graph, output),
      ]);
      recordDarkBackdropBundle(graph, runtime);
    },
    resize(size) {
      resizeDarkTargets(graph, size);
      presentationValid = false;
    },
    bind(time, options) {
      const revealProgress = options?.revealProgress ?? 1;
      const revealChanged = revealProgress !== boundRevealProgress;
      bindDarkGraph(
        graph,
        runtime,
        time,
        (options?.updateScene ?? true) || !presentationValid,
        revealProgress,
        options?.beamWidthReveal ?? 1,
        revealChanged
      );
      boundRevealProgress = revealProgress;
    },
    render(currentFrame, output, options) {
      const updateScene = (options?.updateScene ?? true) || !presentationValid;
      renderDarkGraph(currentFrame, graph, runtime, output, {
        ...options,
        updateScene,
      });
      presentationValid = true;
    },
    debugSources: () => debugSources,
    debugTarget(sourceId) {
      return resolveDarkDebugTarget(graph, sourceId);
    },
    destroy() {
      presentationValid = false;
      destroyDarkTargets(graph);
    },
  };
}

function resolveDarkDebugTarget(
  graph: DarkPipelineGraph,
  sourceId: string
): PrismDebugTargetPreview | undefined {
  const backdrop = graph.backgroundTarget;
  const scene = graph.sceneTarget;
  const bloom = graph.bloomTargets;
  if (sourceId === "dark-backdrop-hdr" && backdrop)
    return { primary: backdrop };
  if (sourceId === "dark-scene-hdr" && scene) return { primary: scene };
  if (sourceId === "dark-presentation-ldr" && graph.presentationTarget)
    return { primary: graph.presentationTarget };
  if (sourceId === "dark-front-glass" && scene && backdrop) {
    return {
      primary: scene,
      secondary: backdrop,
      mode: "difference",
      differenceGain: 5,
    };
  }
  if (sourceId === "dark-bloom-composite" && bloom)
    return { primary: bloom[0].horizontal };
  if (
    sourceId === "dark-particle-light" &&
    bloom &&
    graph.dedicatedParticleLight
  )
    return { primary: bloom[graph.bloomVisibleLevels]!.vertical };

  const level = /^dark-bloom-(\d+)$/.exec(sourceId)?.[1];
  const index = level === undefined ? -1 : Number.parseInt(level, 10);
  if (bloom && index >= 0 && index < graph.bloomVisibleLevels)
    return { primary: bloom[index]!.vertical };
  return undefined;
}

function compileGraph(
  graph: DarkPipelineGraph,
  output: PrismOutput
): Promise<unknown>[] {
  const background = graph.backgroundTarget!;
  const scene = graph.sceneTarget!;
  const bloom = graph.bloomTargets!;
  const presentation = graph.presentationTarget!;
  const outputSignature = { colors: [output.format] } as const;
  return [
    graph.light.compile(background),
    graph.glassBack.compile(background),
    ...(graph.lightWireframe ? [graph.lightWireframe.compile(background)] : []),
    graph.copyBackground.compile(scene),
    graph.glassFront.compile(scene),
    ...(graph.wireframe ? [graph.wireframe.compile(scene)] : []),
    graph.dust.compile(outputSignature),
    graph.bloomExtract.compile(bloom[0].vertical),
    ...graph.bloomBlur.flatMap((level, index) => [
      level.horizontal.compile(bloom[index]!.horizontal),
      level.vertical.compile(bloom[index]!.vertical),
    ]),
    graph.bloomComposite.compile(bloom[0].horizontal),
    ...(graph.particleLightDownsample
      ? [
          graph.particleLightDownsample.compile(
            bloom[graph.bloomVisibleLevels]!.vertical
          ),
        ]
      : []),
    graph.present.compile(presentation),
    graph.copyPresentation.compile(outputSignature),
  ];
}
