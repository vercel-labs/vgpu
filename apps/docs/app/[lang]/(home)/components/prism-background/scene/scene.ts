/**
 * Compatibility facade for thumbnails, validation, and focused geometry tests.
 * Browser integration talks to the same retained runtime/pipeline pair through
 * these functions while light-mode selection is wired in `renderer.ts`.
 */

import type { Frame, Gpu } from "vgpu";
import { frame } from "vgpu";

import { createDarkPipeline } from "../pipelines/dark";
import type { PrismOutput, PrismPipeline } from "../pipelines/types";
import { createPrismRuntime, destroyPrismRuntime } from "../runtime/resources";
import {
  incidenceAt,
  lampAt,
  resizeRuntime,
  setRuntimeControls,
  setRuntimeFramingViewport,
  setRuntimeLampAim,
  setRuntimeLampArc,
  setRuntimeOrbit,
  wallExtent,
} from "../runtime/state";
import { glassUniforms, sceneUniforms } from "../runtime/uniforms";
import type { PrismRuntime } from "../runtime/types";
import type { NormalizedViewport } from "./framing";
import type { PrismControls } from "../types";

export { glassUniforms, incidenceAt, lampAt, sceneUniforms, wallExtent };

export interface PrismScene {
  readonly runtime: PrismRuntime;
  readonly pipeline: PrismPipeline;
}

export function createScene(
  gpu: Gpu,
  output: readonly [number, number],
  label: string
): PrismScene {
  const runtime = createPrismRuntime(gpu, output, label);
  return { runtime, pipeline: createDarkPipeline(runtime) };
}

export function setControls(scene: PrismScene, controls: PrismControls): void {
  setRuntimeControls(scene.runtime, controls);
}

export function setLampArc(scene: PrismScene, position: number): void {
  setRuntimeLampArc(scene.runtime, position);
}

export function setLampAim(
  scene: PrismScene,
  arcPosition: number,
  targetPosition: number
): void {
  setRuntimeLampAim(scene.runtime, arcPosition, targetPosition);
}

export function setOrbit(scene: PrismScene, x: number, y: number): void {
  setRuntimeOrbit(scene.runtime, x, y);
}

export function setFramingViewport(
  scene: PrismScene,
  viewport: NormalizedViewport | undefined
): void {
  setRuntimeFramingViewport(scene.runtime, viewport);
}

export function resizeScene(
  scene: PrismScene,
  output: readonly [number, number]
): void {
  resizeRuntime(scene.runtime, output);
  scene.pipeline.resize(output);
}

export async function prepareScene(
  scene: PrismScene,
  output: PrismOutput
): Promise<void> {
  await scene.pipeline.prepare(output);
}

export function presentScene(
  scene: PrismScene,
  output: PrismOutput,
  currentFrame?: Frame,
  time = 0,
  updateScene = true
): void {
  scene.pipeline.bind(time, { updateScene });
  const encode = (current: Frame) =>
    scene.pipeline.render(current, output, { updateScene });
  if (currentFrame) encode(currentFrame);
  else frame(scene.runtime.gpu, encode);
}

export function destroyScene(scene: PrismScene): void {
  scene.pipeline.destroy();
  destroyPrismRuntime(scene.runtime);
}
