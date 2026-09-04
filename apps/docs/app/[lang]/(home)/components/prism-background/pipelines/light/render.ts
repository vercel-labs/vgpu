import type { Frame, TimerSpan } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type {
  PrismOutput,
  PrismPassProfile,
  PrismPipelineRenderOptions,
} from "../types";
import type { LightPipelineGraph } from "./types";

export function renderLightGraph(
  current: Frame,
  graph: LightPipelineGraph,
  runtime: PrismRuntime,
  output: PrismOutput,
  options: PrismPipelineRenderOptions = {}
): void {
  const backdrop = graph.backdropHDR;
  const scene = graph.sceneHDR;
  if (!backdrop || !scene) {
    throw new Error("prepare() must run before rendering the light pipeline.");
  }
  if (options.updateScene ?? true) {
    renderBackdrop(current, graph, runtime, options.profile);
    current.pass(
      profilePass(
        { target: scene, clear: [0, 0, 0, 1] },
        options.profile,
        "light.scene"
      ),
      (pass) => {
        pass.draw(graph.copyBackdrop);
        if (runtime.controls.view === "glass") {
          pass.draw(graph.glassFront);
          pass.draw(graph.glassAccent);
          if (runtime.controls.wireframe && graph.wireframe)
            pass.draw(graph.wireframe);
        }
      }
    );
  }
  current.pass(
    profilePass({ target: output }, options.profile, "light.present"),
    (pass) => pass.draw(graph.present)
  );
}

function renderBackdrop(
  current: Frame,
  graph: LightPipelineGraph,
  runtime: PrismRuntime,
  profile?: PrismPassProfile
): void {
  const target = graph.backdropHDR!;
  const light = graph.lightMeshLayout;
  const showWall = runtime.controls.view !== "caustic";
  const showLight = runtime.controls.view !== "wall";
  const showGlass =
    runtime.controls.view === "glass" || runtime.controls.view === "back";
  current.pass(
    profilePass({ target, clear: [0, 0, 0, 1] }, profile, "light.backdrop"),
    (pass) => {
      if (
        runtime.controls.view === "glass" &&
        !runtime.controls.lightWireframe &&
        graph.backdropBundle
      ) {
        pass.bundles(graph.backdropBundle);
        return;
      }
      if (showWall) {
        pass.draw(graph.wall);
        pass.draw(graph.prismShadow);
      }
      if (showLight) {
        pass.draw(graph.caustic, {
          firstVertex: 0,
          vertices: light.whiteVertices,
        });
        pass.draw(graph.caustic, {
          firstVertex: light.outgoingFirstVertex,
          vertices: light.outgoingVertices,
        });
      }
      if (showGlass) pass.draw(graph.glassBack);
      if (showLight) {
        pass.draw(graph.caustic, {
          firstVertex: light.internalFirstVertex,
          vertices: light.internalVertices,
        });
      }
      if (runtime.controls.lightWireframe && graph.lightWireframe) {
        pass.draw(graph.lightWireframe);
      }
    }
  );
}

function profilePass<T extends { readonly target: PrismOutput }>(
  options: T,
  profile: PrismPassProfile | undefined,
  name: string
): T | (T & { readonly timer: TimerSpan }) {
  const timer = profile?.pass(name);
  return timer ? { ...options, timer } : options;
}
