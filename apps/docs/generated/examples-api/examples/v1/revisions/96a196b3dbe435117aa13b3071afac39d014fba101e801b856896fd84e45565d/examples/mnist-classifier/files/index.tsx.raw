"use client";

import { useEffect, useRef } from "react";
import { createRenderer } from "./ort-runtime";

export function Example() {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const renderer = createRenderer(root);
    void renderer.ready;
    return () => renderer.dispose();
  }, []);

  return (
    <div
      ref={rootRef}
      className="relative flex h-full w-full flex-col gap-4 overflow-auto bg-black p-4 text-gray-11"
    >
      <div className="flex flex-wrap items-start gap-5">
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-gray-9">
              draw
            </span>
            <span className="font-mono text-[10px] text-gray-9">280 × 280</span>
          </div>
          <canvas
            data-mnist="draw"
            width={280}
            height={280}
            aria-label="Drawing surface for a handwritten digit"
            className="h-[280px] w-[280px] cursor-crosshair touch-none rounded-lg border border-gray-4 bg-black transition-colors hover:border-gray-5"
          />
        </div>

        <div className="relative min-w-[360px] flex-1">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-gray-9">
              probability
            </span>
            <span className="font-mono text-[10px] text-gray-9">
              softmax(logits)
            </span>
          </div>
          <canvas
            data-mnist="chart"
            aria-label="Class probabilities rendered from the model's GPU-resident logits"
            className="mt-2 block h-[280px] w-full rounded-lg border border-gray-4 bg-gray-1"
          />
          <div className="grid grid-cols-10 pt-1.5 text-center font-mono text-[11px] tabular-nums text-gray-9">
            {Array.from({ length: 10 }, (_, digit) => (
              <span key={digit}>{digit}</span>
            ))}
          </div>

          <div
            data-mnist="loading"
            className="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <p
              data-mnist="loading-detail"
              className="rounded-lg border border-gray-4 bg-gray-2 px-3 py-2 font-mono text-xs text-gray-11"
            >
              Preparing inference…
            </p>
          </div>

          <div
            data-mnist="failure"
            hidden
            className="absolute inset-0 flex items-center justify-center p-4"
          >
            <div className="max-w-md rounded-lg border border-gray-4 bg-gray-2 p-3 text-sm">
              <h2
                data-mnist="failure-title"
                className="mb-1 font-medium text-gray-12"
              />
              <p className="mb-2 text-gray-9">
                This example runs ONNX Runtime Web on the WebGPU execution
                provider so vgpu can share its device. It does not fall back to
                CPU inference.
              </p>
              <p
                data-mnist="failure-detail"
                className="font-mono text-xs text-gray-9"
              />
            </div>
          </div>
        </div>
      </div>

      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-gray-9">
        <span
          data-mnist="dot"
          aria-hidden
          className="inline-block h-1.5 w-1.5 rounded-full bg-gray-6"
        />
        <span data-mnist="status" className="text-gray-11">
          inferences: 0
        </span>
      </p>
    </div>
  );
}
