"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useExampleErrorReporter } from "../../lib/example-error-reporter";
import { Controls } from "./controls";
import { createRenderer, type PrismRenderer } from "./renderer";
import type { EnvironmentDebugRenderer } from "./environment-debug";
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from "./types";

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PrismRenderer | null>(null);
  const [environmentDebug, setEnvironmentDebug] = useState(() => ({
    visible: DEFAULT_PRISM_CONTROLS.environmentDebug,
    exposure: DEFAULT_PRISM_CONTROLS.glass.environmentExposure,
  }));

  const setControls = useCallback((controls: PrismControls) => {
    const nextDebug = {
      visible: controls.environmentDebug ?? DEFAULT_PRISM_CONTROLS.environmentDebug,
      exposure:
        controls.glass?.environmentExposure
        ?? DEFAULT_PRISM_CONTROLS.glass.environmentExposure,
    };
    setEnvironmentDebug((current) =>
      current.visible === nextDebug.visible && current.exposure === nextDebug.exposure
        ? current
        : nextDebug
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
      {environmentDebug.visible
        ? (
          <EnvironmentDebugCanvas
            environmentExposure={environmentDebug.exposure}
            onError={reportError}
          />
        )
        : null}
    </div>
  );
}

interface EnvironmentDebugCanvasProps {
  readonly environmentExposure: number;
  onError(error: unknown): void;
}

function EnvironmentDebugCanvas({
  environmentExposure,
  onError,
}: EnvironmentDebugCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<EnvironmentDebugRenderer | undefined>(undefined);
  const onErrorRef = useRef(onError);
  const exposureRef = useRef(environmentExposure);
  onErrorRef.current = onError;
  exposureRef.current = environmentExposure;

  useEffect(() => {
    rendererRef.current?.setEnvironmentExposure(environmentExposure);
  }, [environmentExposure]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let renderer: EnvironmentDebugRenderer | undefined;

    void import("./environment-debug").then(
      ({ createEnvironmentDebugRenderer }) => {
        if (disposed) return;
        try {
          renderer = createEnvironmentDebugRenderer({
            canvas,
            initialEnvironmentExposure: exposureRef.current,
            onError: (error) => onErrorRef.current(error),
          });
          rendererRef.current = renderer;
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
      if (rendererRef.current === renderer) rendererRef.current = undefined;
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
