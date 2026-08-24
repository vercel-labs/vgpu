/**
 * A decoded-frame source built on `HTMLVideoElement.requestVideoFrameCallback`.
 *
 * The point of the API is that it fires once per *presented* frame and hands back
 * the metadata of that exact frame, instead of once per display refresh. A 24 fps
 * clip on a 120 Hz display presents a new frame roughly every fifth rAF tick, so a
 * naive `requestAnimationFrame` upload loop would re-copy the same decoded picture
 * into the GPU texture four times out of five.
 *
 * This module promises the renderer exactly two things: here is the newest decoded
 * frame, and here is a token that changes only when that frame changes. The
 * renderer copies into its texture when the token moves and otherwise leaves the
 * texture alone, so texture uploads track the video's frame rate while the cube
 * keeps spinning at the display's.
 *
 * Browsers that do not implement `requestVideoFrameCallback` (Firefox at the time
 * of writing) fall back to rAF plus a `currentTime` change test, which produces the
 * same one-token-per-frame contract at slightly coarser resolution.
 *
 * @see https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
 */

/** Minimal shape of `requestVideoFrameCallback`, which TypeScript's DOM lib still lacks. */
interface VideoFrameMetadata {
  readonly mediaTime: number;
  readonly presentedFrames: number;
  readonly width: number;
  readonly height: number;
  readonly expectedDisplayTime: number;
}

type VideoFrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (
    callback: (now: number, metadata: VideoFrameMetadata) => void,
  ) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export class VideoUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'unsupported' | 'failed',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'VideoUnavailableError';
  }
}

export interface VideoFrameInfo {
  /** Presentation timestamp of the newest frame, in media seconds. */
  readonly mediaTime: number;
  /** Frames the compositor has presented since playback began. */
  readonly presentedFrames: number;
  /** True when the count comes from `requestVideoFrameCallback` rather than the rAF fallback. */
  readonly precise: boolean;
}

export interface VideoSource {
  /** Intrinsic size of the decoded picture; the texture is allocated to match. */
  readonly width: number;
  readonly height: number;
  /** The off-DOM element `copyExternalImageToTexture` reads from. */
  readonly frame: HTMLVideoElement;
  /** Changes whenever a new frame has been decoded and presented. */
  readonly token: number;
  /** Metadata of the newest presented frame. */
  readonly info: VideoFrameInfo;
  /** Begins notifications. Idempotent. */
  start(onFrame: (token: number) => void): void;
  /** Stops notifications but keeps the element loaded. */
  pause(): void;
  /** Stops notifications and releases the element. Idempotent. */
  dispose(): void;
}

export interface VideoSourceOptions {
  readonly url: string;
  readonly loop?: boolean;
}

/**
 * Loads a video and resolves once its intrinsic size is known.
 *
 * The element is muted, `playsInline` and never attached to the DOM: it exists only
 * as a decode target for `copyExternalImageToTexture`, and a muted element is
 * allowed to autoplay without a user gesture.
 */
export async function loadVideo(options: VideoSourceOptions): Promise<VideoSource> {
  if (typeof document === 'undefined') {
    throw new VideoUnavailableError('Video decoding is only available in a browser.', 'unsupported');
  }

  const video = document.createElement('video') as VideoFrameCallbackHost;
  video.muted = true;
  video.loop = options.loop ?? true;
  video.playsInline = true;
  video.autoplay = true;
  video.preload = 'auto';
  video.crossOrigin = 'anonymous';
  video.src = options.url;

  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener('loadeddata', onReady);
      video.removeEventListener('error', onFail);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onFail = () => {
      cleanup();
      reject(new VideoUnavailableError(`The video at ${options.url} failed to load.`, 'failed'));
    };
    // readyState >= 2 (HAVE_CURRENT_DATA) guarantees there is a frame to copy, so
    // the first upload cannot land on an empty picture.
    if (video.readyState >= 2 && video.videoWidth > 0) {
      resolve();
      return;
    }
    video.addEventListener('loadeddata', onReady, { once: true });
    video.addEventListener('error', onFail, { once: true });
  });

  await video.play().catch(() => {
    // A muted, off-DOM element is allowed to autoplay; if play() is still rejected
    // the frame callbacks below never fire and the cube spins on its first frame,
    // which is honest rather than broken.
  });

  const precise = typeof video.requestVideoFrameCallback === 'function';
  let token = 0;
  let info: VideoFrameInfo = { mediaTime: 0, presentedFrames: 0, precise };
  let disposed = false;
  let running = false;
  let rafHandle = 0;
  let videoHandle = 0;
  let lastTime = -1;
  let notify: ((token: number) => void) | undefined;

  const publish = (next: VideoFrameInfo) => {
    token++;
    info = next;
    notify?.(token);
  };

  const tick = () => {
    if (disposed || !running) return;
    if (precise) {
      // The precise path: one callback per presented frame, with that frame's own
      // metadata, so every token corresponds to bytes the renderer has not copied.
      videoHandle = video.requestVideoFrameCallback!((_now, metadata) => {
        if (disposed || !running) return;
        publish({
          mediaTime: metadata.mediaTime,
          presentedFrames: metadata.presentedFrames,
          precise: true,
        });
        tick();
      });
      return;
    }
    // Fallback: rAF plus a `currentTime` change test, so a 120 Hz loop over a
    // 24 fps clip still produces one token per actual frame.
    rafHandle = requestAnimationFrame(() => {
      if (disposed || !running) return;
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        publish({
          mediaTime: video.currentTime,
          presentedFrames: info.presentedFrames + 1,
          precise: false,
        });
      }
      tick();
    });
  };

  const stopNotifications = () => {
    running = false;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    rafHandle = 0;
    if (videoHandle && video.cancelVideoFrameCallback) {
      video.cancelVideoFrameCallback(videoHandle);
    }
    videoHandle = 0;
  };

  return {
    width: video.videoWidth || 640,
    height: video.videoHeight || 360,
    frame: video,
    get token() {
      return token;
    },
    get info() {
      return info;
    },
    start(onFrame) {
      if (disposed || running) return;
      notify = onFrame;
      running = true;
      tick();
    },
    pause() {
      stopNotifications();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopNotifications();
      notify = undefined;
      try {
        video.pause();
      } catch {
        // Pausing a detached element can throw in some engines; irrelevant here.
      }
      video.removeAttribute('src');
      video.load();
    },
  };
}
