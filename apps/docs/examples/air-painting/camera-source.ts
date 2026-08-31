// The GUI requests this off-DOM webcam source explicitly; frames stay local.
export class CameraUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "insecure" | "unsupported" | "denied" | "failed",
    readonly detail?: unknown
  ) {
    super(message);
    this.name = "CameraUnavailableError";
  }
}

export type CameraFailureReason = CameraUnavailableError["reason"];

export interface CameraNotice {
  readonly reason: CameraFailureReason;
  readonly message: string;
  readonly hint: string;
}

const CAMERA_HINTS: Record<CameraFailureReason, string> = {
  insecure: "Open this example over https, or run it on localhost.",
  unsupported:
    "Try a recent Chrome, Edge, or Safari build on a device with a camera.",
  denied: "Allow camera access for this page, then enable the camera again.",
  failed:
    "Close any other app or tab using the camera, then enable the camera again.",
};

// A missing, blocked, or busy camera is the visitor's environment, not a bug:
// the example renders this copy in place of crashing the preview.
export function describeCameraFailure(
  error: CameraUnavailableError
): CameraNotice {
  return {
    reason: error.reason,
    message: error.message,
    hint: CAMERA_HINTS[error.reason],
  };
}

type VideoFrameCallbackHost = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: (now: number) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ?? new DOMException("Camera request aborted.", "AbortError")
  );
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

function stopStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

export async function requestCamera(signal: AbortSignal) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    throw new CameraUnavailableError(
      "The camera is only available in a browser.",
      "unsupported"
    );
  }
  if (!window.isSecureContext) {
    throw new CameraUnavailableError(
      "Camera access needs a secure context (https or localhost).",
      "insecure"
    );
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraUnavailableError(
      "This browser does not expose getUserMedia, so the camera cannot be used.",
      "unsupported"
    );
  }

  const pendingStream = navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
  });
  let stream: MediaStream;
  try {
    stream = await abortable(pendingStream, signal);
  } catch (error) {
    if (signal.aborted) {
      void pendingStream.then(stopStream, () => undefined);
      throw error;
    }
    const name = (error as { name?: string } | undefined)?.name;
    const denied = name === "NotAllowedError" || name === "SecurityError";
    throw new CameraUnavailableError(
      denied
        ? "Camera permission was declined."
        : "The camera could not be started on this device.",
      denied ? "denied" : "failed",
      error
    );
  }

  const video = document.createElement("video") as VideoFrameCallbackHost;
  video.muted = true;
  video.playsInline = true;
  video.autoplay = true;
  video.srcObject = stream;

  const stopTracks = () => stopStream(stream);

  try {
    await new Promise<void>((resolve, reject) => {
      const onReady = () => {
        cleanup();
        resolve();
      };
      const onFail = () => {
        cleanup();
        reject(
          new CameraUnavailableError(
            "The camera stream failed to produce metadata.",
            "failed"
          )
        );
      };
      const onAbort = () => {
        cleanup();
        reject(abortReason(signal));
      };
      const cleanup = () => {
        video.removeEventListener("loadedmetadata", onReady);
        video.removeEventListener("error", onFail);
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (video.readyState >= 1 && video.videoWidth > 0) {
        resolve();
        return;
      }
      video.addEventListener("loadedmetadata", onReady, { once: true });
      video.addEventListener("error", onFail, { once: true });
      signal.addEventListener("abort", onAbort, { once: true });
    });
    await abortable(
      video.play().catch(() => undefined),
      signal
    );
  } catch (error) {
    video.srcObject = null;
    stopTracks();
    throw error;
  }

  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;

  let token = 0;
  let disposed = false;
  let running = false;
  let rafHandle = 0;
  let videoHandle = 0;
  let lastTime = -1;
  let notify: ((token: number) => void) | undefined;

  const useVideoCallback =
    typeof video.requestVideoFrameCallback === "function";

  const tick = () => {
    if (disposed || !running) return;
    if (useVideoCallback) {
      videoHandle = video.requestVideoFrameCallback!(() => {
        if (disposed || !running) return;
        token++;
        notify?.(token);
        tick();
      });
      return;
    }
    // The fallback also checks currentTime so each decoded frame gets one token.
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
    start(onFrame: (token: number) => void) {
      if (disposed || running) return;
      notify = onFrame;
      running = true;
      tick();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      stopNotifications();
      notify = undefined;
      try {
        video.pause();
      } catch {}
      video.srcObject = null;
      stopTracks();
    },
  };
}

export type CameraSource = Awaited<ReturnType<typeof requestCamera>>;
