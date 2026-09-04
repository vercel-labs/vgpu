import { frame, type Gpu, type Target } from 'vgpu';

import { createAnimation } from './animation';
import { generateField } from './field';
import {
  bakeDirt,
  createEffects,
  createResources,
  createTargets,
  destroyResources,
  destroyTargets,
  prewarm,
  renderChain,
  setBindings,
  stepSimulation,
  type Resources,
  type Targets,
} from './pipeline';

interface ThumbOptions {
  readonly warmupFrames?: number;
  /** Seconds into the intro; the default lands after it has converged. */
  readonly time?: number;
  readonly dt?: number;
}

const STEP = 0.05;

export async function renderThumbnail(gpu: Gpu, output: Target, options: ThumbOptions = {}): Promise<void> {
  const field = generateField();
  const animation = createAnimation(field);
  let resources: Resources | undefined;
  let targets: Targets | undefined;
  try {
    resources = createResources(gpu, field);
    const effects = createEffects(gpu, field, resources);
    targets = createTargets(gpu, output.size);
    setBindings(effects, targets, resources, { pixelRatio: 1, repelRadius: animation.repelRadius });
    await prewarm(effects, targets, resources, output);
    bakeDirt(gpu, effects, resources);

    // Advance the intro deterministically, then hold a gentle tilt so the
    // depth of the strokes reads in a still image.
    const time = options.time ?? 7;
    const dt = options.dt ?? 1 / 60;
    animation.rotate(-0.28, 0.42);
    for (let elapsed = 0; elapsed < time; elapsed += STEP) animation.update(Math.min(STEP, time - elapsed));
    animation.settle();

    const currentTargets = targets;
    const currentResources = resources;
    for (let i = 0; i < Math.max(1, options.warmupFrames ?? 60); i++) {
      stepSimulation(effects, currentResources, field, animation, dt);
      frame(gpu, (currentFrame) => renderChain(currentFrame, effects, currentTargets, output));
    }
  } finally {
    await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ]);
    if (targets) destroyTargets(targets);
    if (resources) destroyResources(resources);
  }
}
