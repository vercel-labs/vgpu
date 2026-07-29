/**
 * Webcam acquisition and fresh-frame notification.
 *
 * Privacy, stated plainly and implemented that way: the stream is only requested
 * after an explicit user gesture, it is never attached to the DOM, every frame is
 * processed locally on the GPU/CPU of this machine, and nothing is uploaded
 * anywhere. Stopping the source stops the tracks, which turns the camera
 * indicator off.
 *
 * The only thing this module promises the rest of the example is: "here is the
 * newest decoded frame, and here is a token that changes when it changes". The
 * token is what keeps the scheduler from inferring the same frame twice merely
 * because rAF fired.
 */
export class CameraUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: 'insecure' | 'unsupported' | 'denied' | 'failed',
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'CameraUnavailableError';
  }
}

export interface CameraSource {
  readonly width: number;
  readonly height: number;
  /** The off-DOM element `copyExternalImageToTexture` reads from. */
  readonly frame: HTMLVideoElement;
  /** Changes whenever a new frame has been decoded. */
  readonly token: number;
  /** Begins notifications. Idempotent. */
  start(onFrame: (token: number) => void): void;
  /** Stops notifications but keeps the tracks; used while a tab is hidden. */
  pause(): void;
  /** Stops notifications, stops the tracks, releases the element. Idempotent. */
  dispose(): void;
}

/** Minimal shape of `HTMLVideoElement.requestVideoFrameCallback`, which TS lacks by default. */
type VideoFrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface CameraSourceOptions {
  readonly idealWidth?: number;
  readonly idealHeight?: number;
}

/**
 * Requests the camera and resolves once its real resolution is known.
 *
 * Must be called from a user gesture. The gallery must never call it on load.
 */
export async function requestCamera(options: CameraSourceOptions = {}): Promise<CameraSource> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    throw new CameraUnavailableError('The camera is only available in a browser.', 'unsupported');
  }
  if (!window.isSecureContext) {
    throw new CameraUnavailableError(
      'Camera access needs a secure context (https or localhost).',
      'insecure',
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraUnavailableError(
      'This browser does not expose getUserMedia, so the camera cannot be used.',
      'unsupported',
    );
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: 'user',
        width: { ideal: options.idealWidth ?? 1280 },
        height: { ideal: options.idealHeight ?? 720 },
      },
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    const denied = name === 'NotAllowedError' || name === 'SecurityError';
    throw new CameraUnavailableError(
      denied
        ? 'Camera permission was declined.'
        : 'The camera could not be started on this device.',
      denied ? 'denied' : 'failed',
      error,
    );
  }

  const video = document.createElement('video') as VideoFrameCallbackHost;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onFail = () => {
        cleanup();
        reject(
          new CameraUnavailableError('The camera stream failed to produce metadata.', 'failed'),
        );
      };
      const cleanup = () => {
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('error', onFail);
      };
      if (video.readyState >= 1 && video.videoWidth > 0) {
        resolve();
        return;
      }
      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('error', onFail, { once: true });
    });
    await video.play().catch(() => {
      // A muted, off-DOM element is allowed to autoplay; if play() is still
      // rejected the frame callbacks below simply never fire and the status line
      // stays on "waiting for frames", which is honest.
    });
  } catch (error) {
    stopTracks();
    throw error;
  }

  const width = video.videoWidth || options.idealWidth || 1280;
  const height = video.videoHeight || options.idealHeight || 720;

  let token = 0;
  let disposed = false;
  let running = false;
  let rafHandle = 0;
  let videoHandle = 0;
  let lastTime = -1;
  let notify: ((token: number) => void) | undefined;

  const useVideoCallback = typeof video.requestVideoFrameCallback === 'function';

  const tick = () => {
    if (disposed || !running) return;
    if (useVideoCallback) {
      // The precise path: fires once per decoded frame, so every token is fresh.
      videoHandle = video.requestVideoFrameCallback!(() => {
        if (disposed || !running) return;
        token++;
        notify?.(token);
        tick();
      });
      return;
    }
    // Fallback: rAF plus a currentTime change test, so a 60 Hz loop over a 30 Hz
    // camera still produces one token per actual frame.
    rafHandle = requestAnimationFrame(() => {
      if (disposed || !running) return;
      if (video.readyState >= 2 && video.currentTime !== lastTime) {
        lastTime = video.currentTime;
        token++;
        notify?.(token);
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
    width,
    height,
    frame: video,
    get token() {
      return token;
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
      video.srcObject = null;
      stopTracks();
    },
  };
}
