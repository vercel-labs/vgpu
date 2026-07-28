'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { FIXTURE_STROKES, FIXTURE_SURFACE, STROKE_RADIUS } from './fixtures';
import { foregroundFromRgba, preprocessDigit } from './preprocess';
import { createRenderer, type MnistRenderer, type MnistStatus } from './ort-runtime';

const STAGE_LABELS: Record<string, string> = {
  runtime: 'Loading ONNX Runtime Web…',
  model: 'Fetching the 26 kB model…',
  session: 'Creating the WebGPU session…',
  device: 'Adopting the runtime device…',
  ready: 'Ready',
};

/** Coalescing delay while the pointer is still down. */
const DRAW_DEBOUNCE_MS = 120;

export function Example() {
  const reportError = useExampleErrorReporter();
  const barsCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<MnistRenderer | undefined>(undefined);
  const debounceRef = useRef<number>(0);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | undefined>(undefined);
  const [status, setStatus] = useState<MnistStatus>({ phase: 'initializing' });

  const context = () => {
    const canvas = drawCanvasRef.current;
    return canvas?.getContext('2d', { willReadFrequently: true }) ?? undefined;
  };

  const paintBackground = useCallback((ctx: CanvasRenderingContext2D) => {
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, FIXTURE_SURFACE, FIXTURE_SURFACE);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = STROKE_RADIUS * 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  /** Reads the drawing surface and queues one inference. */
  const submit = useCallback(() => {
    const ctx = context();
    const renderer = rendererRef.current;
    if (!ctx || !renderer) return;
    const image = ctx.getImageData(0, 0, FIXTURE_SURFACE, FIXTURE_SURFACE);
    const field = foregroundFromRgba(image.data, FIXTURE_SURFACE, FIXTURE_SURFACE);
    const pixels = preprocessDigit(field, FIXTURE_SURFACE, FIXTURE_SURFACE);
    if (!pixels) renderer.clear();
    else renderer.classify(pixels);
  }, []);

  const scheduleSubmit = useCallback(() => {
    if (debounceRef.current) return;
    debounceRef.current = window.setTimeout(() => {
      debounceRef.current = 0;
      submit();
    }, DRAW_DEBOUNCE_MS);
  }, [submit]);

  useEffect(() => {
    const canvas = barsCanvasRef.current;
    const ctx = context();
    if (!canvas || !ctx) return;

    paintBackground(ctx);
    // Seed a stroke so the example shows a real result without interaction.
    ctx.beginPath();
    for (const stroke of FIXTURE_STROKES) {
      stroke.forEach(([x, y], index) => (index === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
    }
    ctx.stroke();

    const renderer = createRenderer({
      canvas,
      onError: reportError,
      onStatus: (next) => {
        setStatus(next);
        if (next.phase === 'ready' && next.runs === 0) submit();
      },
    });
    rendererRef.current = renderer;
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });

    return () => {
      if (debounceRef.current) window.clearTimeout(debounceRef.current);
      debounceRef.current = 0;
      rendererRef.current = undefined;
      renderer.dispose();
    };
  }, [paintBackground, reportError, submit]);

  const pointerPosition = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * FIXTURE_SURFACE,
      y: ((event.clientY - rect.top) / rect.height) * FIXTURE_SURFACE,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const ctx = context();
    if (!ctx) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawingRef.current = true;
    const point = pointerPosition(event);
    lastPointRef.current = point;
    // A dot is a valid digit stroke, so draw immediately.
    ctx.beginPath();
    ctx.moveTo(point.x, point.y);
    ctx.lineTo(point.x + 0.01, point.y);
    ctx.stroke();
    scheduleSubmit();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = context();
    const previous = lastPointRef.current;
    if (!ctx || !previous) return;
    const point = pointerPosition(event);
    ctx.beginPath();
    ctx.moveTo(previous.x, previous.y);
    ctx.lineTo(point.x, point.y);
    ctx.stroke();
    lastPointRef.current = point;
    scheduleSubmit();
  };

  const endStroke = () => {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    lastPointRef.current = undefined;
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = 0;
    // The final stroke always wins.
    submit();
  };

  const clear = () => {
    const ctx = context();
    if (ctx) paintBackground(ctx);
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = 0;
    rendererRef.current?.clear();
  };

  const initializing = status.phase === 'initializing';
  const blocked = status.phase === 'unsupported' || status.phase === 'error';

  return (
    <div className="flex h-full w-full flex-col gap-4 overflow-auto bg-black p-4 text-gray-11">
      {/* No prose in here: the gallery and the docs page carry the description,
          including the note that the 40-byte output makes this an interop
          demonstration rather than a speedup. */}
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-gray-9">
              draw
            </span>
            <span className="font-mono text-[10px] text-gray-9">280 × 280</span>
          </div>
          <canvas
            ref={drawCanvasRef}
            width={FIXTURE_SURFACE}
            height={FIXTURE_SURFACE}
            aria-label="Drawing surface for a handwritten digit"
            className="h-[280px] w-[280px] cursor-crosshair touch-none rounded-lg border border-gray-4 bg-black transition-colors hover:border-gray-5"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={endStroke}
          />
          <button
            type="button"
            onClick={clear}
            className="self-start rounded-md border border-gray-4 bg-gray-1 px-3 py-1 font-mono text-[11px] text-gray-9 transition-colors hover:border-gray-5 hover:bg-gray-2 hover:text-gray-12"
          >
            clear
          </button>
        </div>

        <div className="relative min-w-[360px] flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-gray-9">
              probability
            </span>
            <span className="font-mono text-[10px] text-gray-9">softmax(logits)</span>
          </div>
          <canvas
            ref={barsCanvasRef}
            aria-label="Class probabilities rendered from the model's GPU-resident logits"
            className="mt-2 block h-[280px] w-full rounded-lg border border-gray-4 bg-gray-1"
          />
          {/* Static labels: reading the winning class from the GPU would require a
              readback, which this example deliberately avoids. The chart uses the
              full canvas width, one tenth per class, so this ten-column grid puts
              every digit under its own bar. */}
          <div className="grid grid-cols-10 pt-1.5 text-center font-mono text-[11px] tabular-nums text-gray-9">
            {Array.from({ length: 10 }, (_, digit) => (
              <span key={digit}>{digit}</span>
            ))}
          </div>

          {initializing && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded-lg border border-gray-4 bg-gray-2 px-3 py-2 font-mono text-xs text-gray-11">
                {(status.detail && STAGE_LABELS[status.detail]) ?? 'Preparing inference…'}
              </p>
            </div>
          )}

          {blocked && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="max-w-md rounded-lg border border-gray-4 bg-gray-2 p-3 text-sm">
                <h2 className="mb-1 font-medium text-gray-12">
                  {status.phase === 'unsupported' ? 'WebGPU inference is required' : 'Inference failed'}
                </h2>
                <p className="mb-2 text-gray-9">
                  This example runs ONNX Runtime Web on the WebGPU execution provider so vgpu can
                  share its device. It does not fall back to CPU inference.
                </p>
                {status.detail && <p className="font-mono text-xs text-gray-9">{status.detail}</p>}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-gray-9">
        <span
          aria-hidden
          className={`inline-block h-1.5 w-1.5 rounded-full ${
            status.phase === 'classifying'
              ? 'bg-blue-9'
              : status.phase === 'ready'
                ? 'bg-gray-8'
                : 'bg-gray-6'
          }`}
        />
        <span className="text-gray-11">
          {status.phase === 'classifying' ? 'running inference…' : `inferences: ${status.runs ?? 0}`}
        </span>
      </p>
    </div>
  );
}
