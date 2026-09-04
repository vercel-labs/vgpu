import { glassUniforms, sceneUniforms } from "../../runtime/uniforms";
import type { PrismRuntime } from "../../runtime/types";
import { ensureLightWireframeDraws } from "./create-graph";
import { lightGlassAccentUniforms } from "./passes/glass-accent/uniforms";
import { prismShadowUniforms } from "./passes/shadow/tuning";
import {
  lightCausticUniforms,
  lightPresentUniforms,
  lightWallUniforms,
} from "./uniforms";
import type { LightPipelineGraph } from "./types";

export function bindLightGraph(
  graph: LightPipelineGraph,
  runtime: PrismRuntime,
  updateScene = true,
  revealProgress = 1,
  beamWidthReveal = 1
): void {
  const backdrop = graph.backdropHDR;
  const scene = graph.sceneHDR;
  const assets = graph.assets;
  const studio = runtime.studioEnvironment;
  if (!backdrop || !scene || !assets) {
    throw new Error(
      "prepare() must create light targets and assets before bind()."
    );
  }
  if (!studio) {
    throw new Error("prepare() must create prism environments before bind().");
  }
  if (!updateScene) {
    graph.present.set({
      sceneTexture: scene,
      params: lightPresentUniforms(runtime, revealProgress),
    });
    return;
  }
  // Bindings are statically required even when the debug environment is not.
  // Reusing the studio view keeps the production path allocation-free.
  const debug = runtime.debugEnvironment ?? studio;
  ensureLightWireframeDraws(graph, runtime);
  const glassParams = glassUniforms(runtime, "light");
  graph.wall.set({
    params: lightWallUniforms(runtime),
    wallMaterial: assets.wallMaterial,
    wallLighting: assets.wallLighting,
    materialSampler: graph.materialSampler,
  });
  graph.prismShadow.set({
    shadow: prismShadowUniforms(runtime.view.viewProjection),
  });
  graph.caustic.set({
    scene: sceneUniforms(runtime, beamWidthReveal, graph.lightMeshLayout),
    caustic: lightCausticUniforms(runtime),
    causticProfile: assets.causticProfile,
    causticSampler: graph.materialSampler,
    wallMaterial: assets.wallMaterial,
  });
  graph.glassBack.set({
    params: glassParams,
    studioEnvironment: studio.texture,
    debugEnvironment: debug.texture,
    environmentSampler: runtime.environmentSampler,
  });
  graph.copyBackdrop.set({ sceneTexture: backdrop });
  graph.glassFront.set({
    params: glassParams,
    sceneTexture: backdrop,
    sceneSampler: runtime.sceneSampler,
    studioEnvironment: studio.texture,
    debugEnvironment: debug.texture,
    environmentSampler: runtime.environmentSampler,
  });
  graph.glassAccent.set({
    params: glassParams,
    accent: lightGlassAccentUniforms(),
    studioEnvironment: studio.texture,
    debugEnvironment: debug.texture,
    environmentSampler: runtime.environmentSampler,
  });
  graph.wireframe?.set({
    params: { viewProjection: runtime.view.viewProjection },
  });
  graph.lightWireframe?.set({
    scene: sceneUniforms(runtime, beamWidthReveal, graph.lightMeshLayout),
  });
  graph.present.set({
    sceneTexture: scene,
    params: lightPresentUniforms(runtime, revealProgress),
  });
}
