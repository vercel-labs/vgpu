'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { DEFAULT_MODEL_ID, DEPTH_MODELS, type DepthModelId } from './model-contract';
import {
  createDepthRenderer,
  SOURCE_IMAGE_URL,
  type DepthRenderer,
  type DepthStatus,
} from './ort-runtime';

const MIB = 1024 * 1024;

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<DepthRenderer | undefined>(undefined);
  const [status, setStatus] = useState<DepthStatus>({
    phase: 'initializing',
    modelId: DEFAULT_MODEL_ID,
    source: 'image',
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createDepthRenderer({
      canvas,
      imageUrl: SOURCE_IMAGE_URL,
      onStatus: setStatus,
      onError: reportError,
    });
    rendererRef.current = renderer;
    return () => {
      rendererRef.current = undefined;
      renderer.dispose();
    };
  }, [reportError]);

  const busy =
    status.phase === 'initializing' ||
    status.phase === 'loading-model' ||
    status.phase === 'estimating';
  const downloadPercent =
    status.downloadLoadedBytes !== undefined && status.downloadTotalBytes
      ? Math.min(100, (status.downloadLoadedBytes / status.downloadTotalBytes) * 100)
      : undefined;

  return (
    <div className="flex h-full w-full flex-col gap-3 bg-black p-4 text-gray-11">
      {/* No prose in here: the gallery and the docs page carry the description,
          including what each model's numbers actually mean. */}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={status.modelId}
          onChange={(event) => rendererRef.current?.setModel(event.target.value as DepthModelId)}
          aria-label="Depth model"
          className="rounded-md border border-gray-4 bg-gray-1 px-2 py-1 font-mono text-[11px] text-gray-11 transition-colors hover:border-gray-5 focus:border-blue-9 focus:outline-none"
        >
          {DEPTH_MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {`${model.label} · ${(model.bytes / MIB).toFixed(1)} MiB`}
            </option>
          ))}
        </select>

        <div className="flex overflow-hidden rounded-md border border-gray-4">
          {(['image', 'camera'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => rendererRef.current?.setSource(option)}
              aria-pressed={status.source === option}
              className={`px-3 py-1 font-mono text-[11px] transition-colors ${
                status.source === option
                  ? 'bg-gray-3 text-gray-12'
                  : 'bg-gray-1 text-gray-9 hover:bg-gray-2 hover:text-gray-11'
              }`}
            >
              {option}
            </button>
          ))}
        </div>

        {/* Non-verbal progress: a dot that pulses while the GPU is busy. The
            label exists for assistive technology only. */}
        <span
          role="status"
          aria-label={busy ? 'Estimating depth' : 'Idle'}
          className={`ml-1 inline-block h-1.5 w-1.5 rounded-full ${
            status.phase === 'failed' ? 'bg-red-9' : busy ? 'animate-pulse bg-blue-9' : 'bg-gray-8'
          }`}
        />
        {status.lastInferenceMs !== undefined && (
          <span className="font-mono text-[11px] tabular-nums text-gray-9">
            {status.lastInferenceMs.toFixed(1)} ms
          </span>
        )}
        {status.phase === 'camera-unavailable' && (
          <span className="font-mono text-[11px] text-gray-9">camera unavailable</span>
        )}
      </div>

      {downloadPercent !== undefined && (
        <div
          role="progressbar"
          aria-label="Downloading depth model"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(downloadPercent)}
          className="h-0.5 w-full overflow-hidden rounded-full bg-gray-3"
        >
          <div
            className="h-full bg-blue-9 transition-[width] duration-150"
            style={{ width: `${downloadPercent}%` }}
          />
        </div>
      )}

      <canvas
        ref={canvasRef}
        aria-label="Depth relief rendered from the model's GPU-resident depth tensor"
        className="min-h-0 w-full flex-1 rounded-lg border border-gray-4 bg-gray-1"
      />
    </div>
  );
}
