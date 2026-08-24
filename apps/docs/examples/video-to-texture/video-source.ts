/**
 * A decoded-frame source built on `HTMLVideoElement.requestVideoFrameCallback`.
 *
 * The API fires once per *presented* frame rather than once per display refresh,
 * which is the whole reason it exists: it tells the renderer when there are actually
 * new bytes to copy. Browsers without it (Firefox at the time of writing) fall back
 * to rAF plus a quantised clock, which approximates the same contract — see `fps`
 * below for why nothing exact is available there.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
 */

/** The part of `requestVideoFrameCallback` this needs; TypeScript's DOM lib lacks it. */
type VideoFrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface VideoSource {
  /** Intrinsic size of the decoded picture; the texture is allocated to match. */
  readonly width: number;
  readonly height: number;
  /** The off-DOM element `copyExternalImageToTexture` reads from. */
  readonly frame: HTMLVideoElement;
  /** True once per decoded frame, so the caller uploads exactly when bytes change. */
  consume(): boolean;
  dispose(): void;
}

/**
 * Loads a clip and resolves once there is a frame to copy.
 *
 * The element is muted, `playsInline` and never attached to the DOM: it exists only
 * as a decode target, and a muted element may autoplay without a user gesture.
 *
 * `fps` is only consulted on the fallback path, where it is the least-bad way to
 * recover a per-frame signal. Neither obvious alternative works: `currentTime` is a
 * continuous clock that changes on *every* rAF tick, and `totalVideoFrames` counts
 * decodes in batches well ahead of presentation. Quantising the clock by the known
 * frame duration is an approximation, but it is the one that actually tracks frames.
 */
export async function loadVideo(url: string, fps: number): Promise<VideoSource> {
  const video = document.createElement('video') as VideoFrameCallbackHost;
  Object.assign(video, {
    muted: true,
    loop: true,
    playsInline: true,
    autoplay: true,
    preload: 'auto',
    src: url,
  });

  // readyState >= HAVE_CURRENT_DATA guarantees a frame exists, so the first upload
  // cannot land on an empty picture.
  if (video.readyState < 2) {
    await new Promise<void>((resolve, reject) => {
      video.addEventListener('loadeddata', () => resolve(), { once: true });
      video.addEventListener('error', () => reject(new Error(`Cannot load ${url}`)), { once: true });
    });
  }
  // A rejected play() leaves the cube on its first frame, which is honest rather
  // than broken, so it is not worth failing the whole renderer over.
  await video.play().catch(() => undefined);

  let fresh = true;
  let disposed = false;
  let handle = 0;
  let lastIndex = -1;

  const schedule = () => {
    if (disposed) return;
    if (video.requestVideoFrameCallback) {
      handle = video.requestVideoFrameCallback(() => {
        fresh = true;
        schedule();
      });
      return;
    }
    handle = requestAnimationFrame(() => {
      const index = Math.floor(video.currentTime * fps);
      if (video.readyState >= 2 && index !== lastIndex) {
        lastIndex = index;
        fresh = true;
      }
      schedule();
    });
  };
  schedule();

  return {
    width: video.videoWidth,
    height: video.videoHeight,
    frame: video,
    consume() {
      const hadFrame = fresh;
      fresh = false;
      return hadFrame;
    },
    dispose() {
      disposed = true;
      if (video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(handle);
      else cancelAnimationFrame(handle);
      video.pause();
      video.removeAttribute('src');
      video.load();
    },
  };
}
