'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { CameraUnavailableError, requestCamera, type CameraSource } from './camera-source';
import { createDemoRenderer, type AirPaintDemoStatus } from './demo-runtime';
import { createRenderer, type AirPaintStatus } from './ort-runtime';

type Mode = 'demo' | 'camera';

interface Controls {
  clear(): void;
  dispose(): void;
}

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<Controls | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('demo');
  const [camera, setCamera] = useState<CameraSource | undefined>(undefined);
  const [cameraNotice, setCameraNotice] = useState<string | undefined>(undefined);
  const [requesting, setRequesting] = useState(false);
  const [statusLine, setStatusLine] = useState('Starting the visual demo…');
  const [runs, setRuns] = useState(0);
  const [inferenceHz, setInferenceHz] = useState<number | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let controls: Controls;
    if (mode === 'camera' && camera) {
      const renderer = createRenderer({
        canvas,
        camera,
        onError: reportError,
        onStatus: (status: AirPaintStatus) => {
          setRuns(status.runs);
          setInferenceHz(status.inferenceHz);
          setStatusLine(describeCameraStatus(status));
        },
      });
      controls = renderer;
      void renderer.ready.catch(() => {
        // onError already reported initialization failures to the preview host.
      });
    } else {
      const renderer = createDemoRenderer({
        canvas,
        onError: reportError,
        onStatus: (status: AirPaintDemoStatus) => {
          setStatusLine(describeDemoStatus(status));
        },
      });
      controls = renderer;
      void renderer.ready.catch(() => {
        // Same.
      });
    }

    controlsRef.current = controls;
    return () => {
      controlsRef.current = undefined;
      // Disposing the camera renderer also stops the media tracks.
      controls.dispose();
    };
  }, [camera, mode, reportError]);

  const enableCamera = useCallback(async () => {
    if (requesting || mode === 'camera') return;
    setRequesting(true);
    setCameraNotice(undefined);
    try {
      const source = await requestCamera();
      setCamera(source);
      setMode('camera');
      setRuns(0);
      setInferenceHz(undefined);
    } catch (error) {
      const message =
        error instanceof CameraUnavailableError
          ? error.message
          : 'The camera could not be started.';
      setCameraNotice(`${message} Staying in the visual demo.`);
    } finally {
      setRequesting(false);
    }
  }, [mode, requesting]);

  const stopCamera = useCallback(() => {
    if (mode !== 'camera') return;
    // The renderer's cleanup disposes the camera, so just drop it and re-key.
    setCamera(undefined);
    setMode('demo');
    setCameraNotice(undefined);
  }, [mode]);

  const clear = useCallback(() => {
    controlsRef.current?.clear();
  }, []);

  return (
    <div className="flex h-full w-full flex-col gap-3 overflow-auto bg-[#08090c] p-4 text-white/90">
      <p className="max-w-3xl text-xs leading-relaxed text-white/60">
        Paint in the air with your right wrist. ONNX Runtime Web runs MoveNet SinglePose Lightning on
        WebGPU, vgpu adopts ORT&apos;s device, and WGSL reads the 17 GPU-resident keypoints through a
        non-owning zero-copy wrapper: the landmarks are smoothed, unletterboxed and turned into
        strokes without a single byte travelling back to the CPU. The compositor keeps everything
        under a fixed 8&times;8 Bayer dither and reveals the raw camera only where you have painted.
      </p>
      <p className="max-w-3xl text-xs leading-relaxed text-white/45">
        Camera preprocessing is honestly CPU-side: the committed graph takes{' '}
        <code className="text-white/60">uint8 [1,192,192,3]</code>, and a GPU-buffer input tensor was
        rejected by the runtime, so each inference uploads a letterboxed 110 kB frame. The zero-copy
        claim is about the <em>output</em>. Video never leaves this device and is never uploaded
        anywhere.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {mode === 'camera' ? (
          <button
            type="button"
            onClick={stopCamera}
            className="rounded border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
          >
            Stop camera
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void enableCamera()}
            disabled={requesting}
            className="rounded border border-white/25 px-3 py-1 text-xs text-white/85 hover:bg-white/10 disabled:opacity-50"
          >
            {requesting ? 'Requesting camera…' : 'Enable camera'}
          </button>
        )}
        <button
          type="button"
          onClick={clear}
          className="rounded border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
        >
          Clear painting
        </button>
        <span className="font-mono text-[11px] text-white/50" role="status" aria-live="polite">
          {statusLine}
          {mode === 'camera' && runs > 0
            ? ` · ${runs} inferences${inferenceHz ? ` · ${inferenceHz.toFixed(1)} Hz` : ''}`
            : ''}
        </span>
      </div>

      {cameraNotice ? (
        <p className="max-w-3xl rounded border border-amber-400/30 bg-amber-400/5 px-3 py-2 text-xs text-amber-200/80">
          {cameraNotice}
        </p>
      ) : undefined}

      <canvas
        // Re-keying gives each mode a fresh canvas, so a WebGPU context is never
        // reconfigured onto a different device.
        key={mode}
        ref={canvasRef}
        aria-label={
          mode === 'camera'
            ? 'Mirrored camera view, dithered outside the painted strokes'
            : 'Visual demo of the dithered compositor with a synthetic wrist trajectory'
        }
        className="block min-h-[280px] w-full flex-1 rounded border border-white/15"
      />

      {mode === 'camera' ? (
        <p className="max-w-3xl text-[11px] leading-relaxed text-white/40">
          Raise your right hand into frame and move it to draw. Confidence has to reach 0.45 to start
          a stroke and stays live down to 0.30; losing the pose for two results breaks the line
          instead of drawing a connector across the frame.
        </p>
      ) : (
        <p className="max-w-3xl text-[11px] leading-relaxed text-white/40">
          <strong className="text-white/60">Visual demo.</strong> No camera and no pose model: this
          replays a canned frame and a fixed synthetic wrist trajectory through the same wrist, paint
          and composite shaders the camera mode uses. It shows the visuals only and proves nothing
          about ONNX Runtime interop &mdash; enable the camera for that.
        </p>
      )}
    </div>
  );
}

function describeCameraStatus(status: AirPaintStatus): string {
  switch (status.phase) {
    case 'initializing':
      return status.detail ?? 'Initializing…';
    case 'waiting-for-pose':
      return 'Camera live — waiting for a confident right wrist';
    case 'painting':
      return 'Painting from GPU-resident keypoints';
    case 'unsupported':
      return status.detail ?? 'This example needs WebGPU.';
    case 'error':
      return status.detail ?? 'Something went wrong.';
  }
}

function describeDemoStatus(status: AirPaintDemoStatus): string {
  switch (status.phase) {
    case 'initializing':
      return status.detail ?? 'Starting the visual demo…';
    case 'running':
      return 'Visual demo — synthetic trajectory, no pose model';
    case 'unsupported':
      return status.detail ?? 'This example needs WebGPU.';
    case 'error':
      return status.detail ?? 'Something went wrong.';
  }
}
