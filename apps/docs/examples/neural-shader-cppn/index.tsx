'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { createRenderer, type CppnStatus } from './ort-runtime';

const STAGE_LABELS: Record<string, string> = {
  runtime: 'Loading ONNX Runtime Web…',
  model: 'Fetching the 9 KiB model…',
  session: 'Creating the WebGPU session…',
  device: 'Adopting the runtime device…',
  ready: 'Starting the render loop…',
};

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<CppnStatus>({ phase: 'initializing' });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const renderer = createRenderer({ canvas, onError: reportError, onStatus: setStatus });
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });

    return () => renderer.dispose();
  }, [reportError]);

  const initializing = status.phase === 'initializing';
  const blocked = status.phase === 'unsupported' || status.phase === 'error';

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />

      {initializing && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded bg-black/70 px-3 py-2 text-sm text-white/90">
            {(status.detail && STAGE_LABELS[status.detail]) ?? 'Preparing inference…'}
          </p>
        </div>
      )}

      {blocked && (
        <div className="absolute inset-0 flex items-center justify-center p-6">
          <div className="max-w-md rounded border border-white/15 bg-black/85 p-4 text-sm text-white/90">
            <h2 className="mb-2 font-medium">
              {status.phase === 'unsupported' ? 'WebGPU inference is required' : 'Inference failed'}
            </h2>
            <p className="mb-2 text-white/70">
              This example runs a neural network on the GPU with ONNX Runtime Web and shares that
              device with vgpu. It deliberately does not fall back to CPU inference, because that
              would not demonstrate the zero-copy path.
            </p>
            {status.detail && <p className="font-mono text-xs text-white/60">{status.detail}</p>}
          </div>
        </div>
      )}

      {status.phase === 'running' && (
        <div className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/60 px-2 py-1 font-mono text-[11px] text-white/70">
          256x256 inference/frame
          {status.fps !== undefined ? ` · ${status.fps.toFixed(1)} fps` : ''}
          {status.inputMode === 'cpu-tensor' ? ' · CPU coord input' : ' · GPU coord input'}
        </div>
      )}
    </div>
  );
}
