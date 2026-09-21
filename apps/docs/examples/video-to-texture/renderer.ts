import { clock, frameLoop, init, surface, type Gpu } from 'vgpu';

import {
  createScene,
  destroyScene,
  FRAME_SIZE,
  renderScene,
  type VideoCubeScene,
  uploadFrame,
  uploadTestPattern,
} from './scene';
import { loadVideo, type VideoSource } from './video-source';

/**
 * Big Buck Bunny, © 2008 Blender Foundation — CC BY 3.0. See provenance.md.
 *
 * A 10.4s, 640×360, 30 fps excerpt is committed next to the example so the demo has
 * no third-party dependency and no licence ambiguity. Rebuild it with:
 *
 *   ffmpeg -ss 398.95 -i BigBuckBunny_640x360.m4v -an \
 *     -vf "scale=640:360:flags=lanczos,setsar=1,fps=30" -frames:v 312 \
 *     -c:v libx264 -profile:v high -crf 22 -preset veryslow -movflags +faststart out.mp4
 *
 * Both timestamps are shot boundaries in the film, so the clip loops cleanly.
 */
const VIDEO_URL = '/examples/video-to-texture/big-buck-bunny-360p-glide.mp4';
/** Encoded frame rate of that clip; only the no-rVFC fallback needs it. */
const VIDEO_FPS = 30;

/**
 * The two clocks stay separate: `video.consume()` is true once per *decoded* frame,
 * so uploads track the clip's 30 fps, while `frameLoop` runs at the display's
 * refresh rate so the cube spins smoothly. That gap is the point of the example — a
 * naive rAF upload loop would re-copy the same picture three times out of four.
 */
export function createRenderer(canvas: HTMLCanvasElement) {
  const controller = new AbortController();
  let disposed = false;
  let failed = false;
  let gpu: Gpu | undefined;
  let video: VideoSource | undefined;
  let scene: VideoCubeScene | undefined;
  let loop: { stop(): void } | undefined;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();

    const failures: unknown[] = [];
    for (const cleanup of [
      () => loop?.stop(),
      () => video?.dispose(),
      () => scene && destroyScene(scene),
      () => gpu?.dispose(),
    ]) {
      try {
        cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw failures[0];
  };

  const fail = (error: unknown): never => {
    failed = true;
    try {
      dispose();
    } catch {
      // Teardown must not replace the live or initialization failure.
    }
    throw error;
  };

  const initialize = async () => {
    if (disposed) return;
    const nextGpu = await init();
    gpu = nextGpu;
    if (disposed) {
      gpu = undefined;
      try {
        nextGpu.dispose();
      } catch {
        // Intentional stale cleanup is quiet.
      }
      return;
    }

    // A failed load leaves the test pattern on the cube rather than a black box.
    let nextVideo: VideoSource | undefined;
    try {
      nextVideo = await loadVideo(VIDEO_URL, VIDEO_FPS, controller.signal);
    } catch (error) {
      if (controller.signal.aborted) throw error;
    }
    if (disposed) {
      nextVideo?.dispose();
      return;
    }
    video = nextVideo;

    const output = surface(nextGpu, canvas, { dpr: [1, 2] });
    scene = createScene(nextGpu, video ?? FRAME_SIZE);
    uploadTestPattern(nextGpu, scene);
    const time = clock(nextGpu);
    loop = frameLoop(nextGpu, (currentFrame) => {
      if (disposed || !scene) return;
      try {
        if (video?.consume()) uploadFrame(nextGpu, scene, video.frame);
        renderScene(currentFrame, scene, output, time.time);
      } catch (error) {
        fail(error);
      }
    });
  };

  const ready = initialize().catch((error: unknown) => {
    if (disposed && !failed) return;
    fail(error);
  });

  return { ready, dispose };
}
