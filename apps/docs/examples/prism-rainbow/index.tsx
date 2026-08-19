"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useExampleErrorReporter } from "../../lib/example-error-reporter";
import { Controls } from "./controls";
import { createRenderer, type PrismRenderer } from "./renderer";
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from "./types";

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PrismRenderer | null>(null);
  const [showEnvironmentDebug, setShowEnvironmentDebug] = useState(
    DEFAULT_PRISM_CONTROLS.environmentDebug,
  );

  const setControls = useCallback((controls: PrismControls) => {
    setShowEnvironmentDebug(
      controls.environmentDebug ?? DEFAULT_PRISM_CONTROLS.environmentDebug,
    );
    rendererRef.current?.setControls?.(controls);
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({
      canvas,
      initialControls: DEFAULT_PRISM_CONTROLS,
      onError: reportError,
    });
    rendererRef.current = renderer;
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });
    return () => {
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [reportError]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        className="block h-full w-full cursor-ns-resize touch-none"
      />
      <Controls onChange={setControls} />
      {showEnvironmentDebug
        ? <EnvironmentDebugCanvas onError={reportError} />
        : null}
    </div>
  );
}

function EnvironmentDebugCanvas({ onError }: { onError(error: unknown): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let renderer: { readonly ready: Promise<void>; dispose(): void } | undefined;

    void import("./environment-debug").then(
      ({ createEnvironmentDebugRenderer }) => {
        if (disposed) return;
        try {
          renderer = createEnvironmentDebugRenderer({
            canvas,
            onError: (error) => onErrorRef.current(error),
          });
        } catch (error) {
          onErrorRef.current(error);
          return;
        }
        void renderer.ready.catch(() => {
          // The renderer reports initialization failures through onError.
        });
      },
      (error: unknown) => {
        if (!disposed) onErrorRef.current(error);
      },
    );

    return () => {
      disposed = true;
      renderer?.dispose();
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-label="Environment reflection debug"
      className="absolute bottom-3 right-3 z-[3] block size-48 cursor-grab touch-none rounded-sm border border-white/20 bg-black active:cursor-grabbing sm:size-56"
    />
  );
}
