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
    <div className="flex h-full w-full flex-col gap-3 overflow-auto bg-[#08090c] p-4 text-white/90">
      <p className="max-w-3xl text-xs leading-relaxed text-white/60">
        Draw a digit and classify it with ONNX Runtime Web on WebGPU. vgpu adopts ORT&apos;s device and
        renders the ten GPU-resident logits through a non-owning zero-copy buffer wrapper. The output
        is only 40 bytes, so zero-copy is not a meaningful speedup here; this example demonstrates
        the interop API and lifetime contract. Large or per-frame tensors are where eliminating
        transfers becomes performance-relevant.
      </p>

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-2">
          <canvas
            ref={drawCanvasRef}
            width={FIXTURE_SURFACE}
            height={FIXTURE_SURFACE}
            aria-label="Drawing surface for a handwritten digit"
            className="h-[280px] w-[280px] touch-none rounded border border-white/15 bg-black"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endStroke}
            onPointerCancel={endStroke}
            onPointerLeave={endStroke}
          />
          <button
            type="button"
            onClick={clear}
            className="rounded border border-white/20 px-3 py-1 text-xs text-white/80 hover:bg-white/10"
          >
            Clear
          </button>
        </div>

        <div className="relative min-w-[320px] flex-1">
          <canvas
            ref={barsCanvasRef}
            aria-label="Class probabilities rendered from the model's GPU-resident logits"
            className="block h-[280px] w-full rounded border border-white/15"
          />
          {/* Static labels: reading the winning class from the GPU would require a
              readback, which this example deliberately avoids. */}
          <div className="mt-1 grid grid-cols-10 pl-[36%] text-center font-mono text-[11px] text-white/50">
            {Array.from({ length: 10 }, (_, digit) => (
              <span key={digit}>{digit}</span>
            ))}
          </div>

          {initializing && (
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
              <p className="rounded bg-black/70 px-3 py-2 text-sm">
                {(status.detail && STAGE_LABELS[status.detail]) ?? 'Preparing inference…'}
              </p>
            </div>
          )}

          {blocked && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="max-w-md rounded border border-white/15 bg-black/85 p-3 text-sm">
                <h2 className="mb-1 font-medium">
                  {status.phase === 'unsupported' ? 'WebGPU inference is required' : 'Inference failed'}
                </h2>
                <p className="mb-2 text-white/70">
                  This example runs ONNX Runtime Web on the WebGPU execution provider so vgpu can
                  share its device. It does not fall back to CPU inference.
                </p>
                {status.detail && <p className="font-mono text-xs text-white/60">{status.detail}</p>}
              </div>
            </div>
          )}
        </div>
      </div>

      <p className="font-mono text-[11px] text-white/40">
        {status.phase === 'classifying' ? 'running inference…' : `inferences: ${status.runs ?? 0}`} · 40
        bytes of logits, softmax in WGSL, no readback
      </p>
    </div>
  );
}
