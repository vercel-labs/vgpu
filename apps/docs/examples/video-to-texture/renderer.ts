import { clock, frameLoop, init, surface } from 'vgpu';

import { createScene, destroyScene, FRAME_SIZE, renderScene, uploadFrame, uploadTestPattern } from './scene';
import { loadVideo } from './video-source';

/**
 * Big Buck Bunny, © 2008 Blender Foundation — CC BY 3.0 (peach.blender.org).
 *
 * A 10.4s, 640×360, 30 fps excerpt is committed next to the example so the demo has
 * no third-party dependency and no licence ambiguity. Rebuild it with:
 *
 *   ffmpeg -ss 398.95 -t 10.40 -i source.webm -an \
 *     -vf "scale=640:360:flags=lanczos,setsar=1,fps=30" \
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
export async function createRenderer(canvas: HTMLCanvasElement) {
  const gpu = await init();
  try {
    // A failed load leaves the test pattern on the cube rather than a black box.
    const video = await loadVideo(VIDEO_URL, VIDEO_FPS).catch(() => undefined);
    const output = surface(gpu, canvas, { dpr: [1, 2] });
    const scene = createScene(gpu, video ?? FRAME_SIZE);
    uploadTestPattern(gpu, scene);

    const time = clock(gpu);
    frameLoop(gpu, (currentFrame) => {
      if (video?.consume()) uploadFrame(gpu, scene, video.frame);
      renderScene(currentFrame, scene, output, time.time);
    });

    return {
      dispose: () => {
        video?.dispose();
        destroyScene(scene);
        gpu.dispose();
      },
    };
  } catch (error) {
    gpu.dispose();
    throw error;
  }
}
