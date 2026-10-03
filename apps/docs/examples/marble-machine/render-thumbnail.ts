import { frame, type Gpu, type Target } from 'vgpu';

import { createCamera, createFocus, lightMatrices, updateCamera, updateFocus } from './camera';
import { SHADOW_MAP_SIZE, createPipeline, encode, publish } from './pipeline';
import { createScene, syncMarbles } from './scene';
import { createSimulation } from './simulation';

interface Options {
  readonly warmupFrames?: number;
  readonly dt?: number;
  readonly time?: number;
  readonly publicAssetsRoot?: string;
}

/**
 * The default machine after its scripted start, one batch release and `time` seconds of real
 * cannon-es steps, through the live pipeline. Physics advances on the CPU before any GPU work, so warm-up
 * frames only redraw the same state.
 */
export async function renderThumbnail(gpu: Gpu, target: Target, options: Options = {}): Promise<void> {
  const failures: unknown[] = [];
  try {
    const simulation = createSimulation();
    // One batch on top of the scripted start fills every ramp at once.
    simulation.releaseBatch();
    // `dt` frames through the live renderer's fixed-step accumulator, so `time` is simulated seconds.
    const frameSeconds = options.dt ?? 1 / 60;
    const physicsFrames = Math.round((options.time ?? 4) / frameSeconds);
    for (let index = 0; index < physicsFrames; index += 1) simulation.advance(frameSeconds);

    const scene = createScene(simulation);
    syncMarbles(scene, simulation);
    const camera = createCamera();
    const aspect = target.size[0] / target.size[1];
    updateCamera(camera, updateFocus(createFocus(), 'machine', simulation), aspect, 0);
    const light = { view: new Float32Array(16), viewProjection: new Float32Array(16) };
    const shadowTexel = lightMatrices(light, SHADOW_MAP_SIZE);
    const pipeline = await createPipeline(gpu, scene, target.size, target.format, {
      camera: camera.matrices,
      eye: camera.pose.position,
      fov: camera.lens.fov,
      aspect,
      light,
      shadowTexel,
      time: options.time ?? 4,
    });
    publish(pipeline);
    const frames = Math.max(1, options.warmupFrames ?? 1);
    for (let index = 0; index < frames; index += 1) {
      frame(gpu, (currentFrame) => encode(currentFrame, pipeline, target));
    }
  } catch (error) {
    failures.push(error);
  } finally {
    for (const result of await Promise.allSettled([
      Promise.resolve().then(() => gpu.gpu.queue.onSubmittedWorkDone()),
      Promise.resolve().then(() => gpu.settled()),
    ])) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
  }
  if (failures.length > 0) throw failures[0];
}
