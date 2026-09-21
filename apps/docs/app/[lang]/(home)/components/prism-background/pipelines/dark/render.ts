import type { Frame, TimerSpan } from "vgpu";

import type { PrismRuntime } from "../../runtime/types";
import type {
  PrismOutput,
  PrismPassProfile,
  PrismPipelineRenderOptions,
} from "../types";
import { DUST_PARTICLE_COUNT } from "./create-graph";
import type { DarkPipelineGraph } from "./types";
import { darkWallClear } from "./passes/wall/clear";

export function renderDarkGraph(
  current: Frame,
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  output: PrismOutput,
  options: PrismPipelineRenderOptions = {}
): void {
  const background = graph.backgroundTarget;
  const scene = graph.sceneTarget;
  const bloom = graph.bloomTargets;
  const presentation = graph.presentationTarget;
  if (!background || !scene || !bloom || !presentation) {
    throw new Error("prepare() must run before rendering the dark pipeline.");
  }

  if (options.updateScene ?? true) {
    renderBackdrop(current, graph, runtime, options.profile);
    current.pass(
      profilePass(
        { target: scene, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.scene"
      ),
      (pass) => {
        pass.draw(graph.copyBackground);
        if (runtime.controls.view === "glass") {
          pass.draw(graph.glassFront);
          if (runtime.controls.wireframe && graph.wireframe)
            pass.draw(graph.wireframe);
        }
      }
    );
    current.pass(
      profilePass(
        { target: bloom[0].vertical, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.bloom.extract"
      ),
      (pass) => pass.draw(graph.bloomExtract)
    );
    bloom.slice(0, graph.bloomVisibleLevels).forEach((level, index) => {
      current.pass(
        profilePass(
          { target: level.horizontal, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.bloom.${index}.horizontal`
        ),
        (pass) => {
          pass.draw(graph.bloomBlur[index]!.horizontal);
        }
      );
      current.pass(
        profilePass(
          { target: level.vertical, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.bloom.${index}.vertical`
        ),
        (pass) => pass.draw(graph.bloomBlur[index]!.vertical)
      );
    });
    if (graph.dedicatedParticleLight && graph.particleLightDownsample) {
      const particleIndex = graph.bloomVisibleLevels;
      const particleLevel = bloom[particleIndex]!;
      current.pass(
        profilePass(
          { target: particleLevel.vertical, clear: [0, 0, 0, 1] },
          options.profile,
          "dark.particle-light.downsample"
        ),
        (pass) => pass.draw(graph.particleLightDownsample!)
      );
      current.pass(
        profilePass(
          { target: particleLevel.horizontal, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.particle-light.${particleIndex}.horizontal`
        ),
        (pass) => pass.draw(graph.bloomBlur[particleIndex]!.horizontal)
      );
      current.pass(
        profilePass(
          { target: particleLevel.vertical, clear: [0, 0, 0, 1] },
          options.profile,
          `dark.particle-light.${particleIndex}.vertical`
        ),
        (pass) => pass.draw(graph.bloomBlur[particleIndex]!.vertical)
      );
    }
    current.pass(
      profilePass(
        { target: bloom[0].horizontal, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.bloom.composite"
      ),
      (pass) => {
        pass.draw(graph.bloomComposite);
      }
    );
    current.pass(
      profilePass(
        { target: presentation, clear: [0, 0, 0, 1] },
        options.profile,
        "dark.present-cache"
      ),
      (pass) => pass.draw(graph.present)
    );
  }

  current.pass(
    profilePass({ target: output }, options.profile, "dark.output"),
    (pass) => {
      pass.draw(graph.copyPresentation);
      if (runtime.controls.view === "glass") {
        pass.draw(graph.dust, { instances: DUST_PARTICLE_COUNT });
      }
    }
  );
}

function renderBackdrop(
  current: Frame,
  graph: DarkPipelineGraph,
  runtime: PrismRuntime,
  profile?: PrismPassProfile
): void {
  const target = graph.backgroundTarget!;
  const light = graph.lightMeshLayout;
  const showBack =
    runtime.controls.view === "glass" || runtime.controls.view === "back";
  const showLight = runtime.controls.view !== "wall";
  current.pass(
    profilePass(
      {
        target,
        clear: darkWallClear(runtime.controls.wallColor, runtime.controls.view),
      },
      profile,
      "dark.backdrop"
    ),
    (pass) => {
      if (
        runtime.controls.view === "glass" &&
        !runtime.controls.lightWireframe &&
        graph.backdropBundle
      ) {
        pass.bundles(graph.backdropBundle);
        return;
      }
      if (showLight) {
        pass.draw(graph.light, {
          firstVertex: 0,
          vertices: light.whiteVertices,
        });
        pass.draw(graph.light, {
          firstVertex: light.outgoingFirstVertex,
          vertices: light.outgoingVertices,
        });
        if (runtime.controls.lightWireframe && graph.lightWireframe) {
          pass.draw(graph.lightWireframe, {
            firstVertex: 0,
            vertices: light.whiteVertices,
          });
          pass.draw(graph.lightWireframe, {
            firstVertex: light.outgoingFirstVertex,
            vertices: light.outgoingVertices,
          });
        }
      }
      if (showBack) pass.draw(graph.glassBack);
      if (showLight) {
        pass.draw(graph.light, {
          firstVertex: light.internalFirstVertex,
          vertices: light.internalVertices,
        });
        if (runtime.controls.lightWireframe && graph.lightWireframe) {
          pass.draw(graph.lightWireframe, {
            firstVertex: light.internalFirstVertex,
            vertices: light.internalVertices,
          });
        }
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
