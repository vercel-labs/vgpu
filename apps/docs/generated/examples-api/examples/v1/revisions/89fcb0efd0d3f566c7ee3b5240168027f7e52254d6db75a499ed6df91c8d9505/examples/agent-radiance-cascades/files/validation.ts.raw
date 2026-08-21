import type { Gpu, Target } from 'vgpu';

import { createScene, destroyScene, prepareScene, presentScene, renderLighting } from './simulation';
import {
  AGENT_RADIANCE_QUALITY_SETTINGS,
  type AgentRadianceAnimation,
  type AgentRadianceQuality,
  type AgentRadianceView,
} from './types';

export interface DebugCapture {
  readonly name: string;
  readonly time: number;
  readonly view: AgentRadianceView;
  readonly animation: AgentRadianceAnimation;
}

export const DEBUG_CAPTURES: readonly DebugCapture[] = [
  { name: 'frame-00-gray', time: 0, view: 'final', animation: 'center-out' },
  { name: 'frame-01-center', time: 0.55, view: 'final', animation: 'center-out' },
  { name: 'frame-02-middle', time: 0.9, view: 'final', animation: 'center-out' },
  { name: 'frame-03-outer', time: 1.5, view: 'final', animation: 'center-out' },
  { name: 'frame-04-fade', time: 2, view: 'final', animation: 'center-out' },
  { name: 'frame-05-orbit', time: 0.9, view: 'final', animation: 'edge-orbit' },
  { name: 'frame-06-edges', time: 1.7, view: 'final', animation: 'edge-then-center' },
  { name: 'frame-07-edges-center', time: 2.2, view: 'final', animation: 'edge-then-center' },
  { name: 'target-emitters', time: 1.5, view: 'emitters', animation: 'center-out' },
  { name: 'target-jfa', time: 1.5, view: 'jfa', animation: 'center-out' },
  { name: 'target-sdf', time: 1.5, view: 'sdf', animation: 'center-out' },
  { name: 'target-cascade-0', time: 1.5, view: 'cascade-0', animation: 'center-out' },
  { name: 'target-cascade-2', time: 1.5, view: 'cascade-2', animation: 'center-out' },
  { name: 'target-cascade-5', time: 1.5, view: 'cascade-5', animation: 'center-out' },
];

export async function renderDebugCaptures(
  gpu: Gpu,
  output: Target,
  onCapture: (capture: DebugCapture, pixels: Uint8Array) => Promise<void> | void,
  quality: AgentRadianceQuality = 'recording',
): Promise<void> {
  const settings = AGENT_RADIANCE_QUALITY_SETTINGS[quality];
  const scene = createScene(
    gpu,
    [output.size[0], output.size[1]],
    `agent-radiance-debug-${quality}`,
    settings.directionBase,
  );
  try {
    await prepareScene(scene, output.format);
    for (const capture of DEBUG_CAPTURES) {
      renderLighting(scene, capture.time, capture.view, capture.animation);
      presentScene(scene, output, capture.view);
      await gpu.gpu.queue.onSubmittedWorkDone();
      await onCapture(capture, new Uint8Array(await output.read()));
    }
    await gpu.settled();
  } finally {
    destroyScene(scene);
  }
}
