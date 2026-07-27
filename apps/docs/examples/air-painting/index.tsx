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

/**
 * Non-verbal state feedback. The compositor *is* the example, so the chrome gets a
 * dot and two buttons; every explanation lives in the example's description, not
 * inside the frame.
 */
type Tone = 'starting' | 'live' | 'painting';

const TONE_CLASS: Record<Tone, string> = {
  starting: 'bg-gray-6',
  live: 'bg-gray-8',
  painting: 'bg-blue-9',
};

const BUTTON_CLASS =
  'rounded-md border border-gray-4 bg-gray-1 px-3 py-1 font-mono text-[11px] text-gray-9 transition-colors hover:border-gray-5 hover:bg-gray-2 hover:text-gray-12 disabled:opacity-50';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const controlsRef = useRef<Controls | undefined>(undefined);
  const [mode, setMode] = useState<Mode>('demo');
  const [camera, setCamera] = useState<CameraSource | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [requesting, setRequesting] = useState(false);
  const [tone, setTone] = useState<Tone>('starting');
  const [blocked, setBlocked] = useState<string | undefined>(undefined);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setTone('starting');
    setBlocked(undefined);

    let controls: Controls;
    if (mode === 'camera' && camera) {
      const renderer = createRenderer({
        canvas,
        camera,
        onError: reportError,
        onStatus: (status: AirPaintStatus) => {
          setTone(cameraTone(status.phase));
          setBlocked(blockedDetail(status.phase, status.detail));
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
          setTone(status.phase === 'running' ? 'painting' : 'starting');
          setBlocked(blockedDetail(status.phase, status.detail));
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
    setNotice(undefined);
    try {
      const source = await requestCamera();
      setCamera(source);
      setMode('camera');
    } catch (error) {
      // A failed permission prompt needs saying: without it the button looks dead.
      setNotice(
        error instanceof CameraUnavailableError
          ? error.message
          : 'The camera could not be started.',
      );
    } finally {
      setRequesting(false);
    }
  }, [mode, requesting]);

  const stopCamera = useCallback(() => {
    if (mode !== 'camera') return;
    // The renderer's cleanup disposes the camera, so just drop it and re-key.
    setCamera(undefined);
    setMode('demo');
    setNotice(undefined);
  }, [mode]);

  const clear = useCallback(() => {
    controlsRef.current?.clear();
  }, []);

  return (
    <div className="flex h-full w-full flex-col gap-3 bg-black p-4">
      <div className="relative min-h-[280px] flex-1">
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
          className="block h-full w-full rounded-lg border border-gray-4 bg-gray-1"
        />
        {blocked && (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            <p className="rounded-lg border border-gray-4 bg-gray-2 px-3 py-2 font-mono text-[11px] text-gray-11">
              {blocked}
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${TONE_CLASS[tone]}`}
        />
        {mode === 'camera' ? (
          <button type="button" onClick={stopCamera} className={BUTTON_CLASS}>
            stop camera
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void enableCamera()}
            disabled={requesting}
            className={BUTTON_CLASS}
          >
            {requesting ? 'requesting…' : 'enable camera'}
          </button>
        )}
        <button type="button" onClick={clear} className={BUTTON_CLASS}>
          clear
        </button>
        {notice && (
          <span className="font-mono text-[11px] text-gray-9" role="status" aria-live="polite">
            {notice}
          </span>
        )}
      </div>
    </div>
  );
}

function cameraTone(phase: AirPaintStatus['phase']): Tone {
  if (phase === 'painting') return 'painting';
  if (phase === 'waiting-for-pose') return 'live';
  return 'starting';
}

/** Only failure states get words; everything else is the dot. */
function blockedDetail(
  phase: AirPaintStatus['phase'] | AirPaintDemoStatus['phase'],
  detail: string | undefined,
): string | undefined {
  if (phase === 'unsupported') return detail ?? 'This example needs WebGPU.';
  if (phase === 'error') return detail ?? 'Something went wrong.';
  return undefined;
}
