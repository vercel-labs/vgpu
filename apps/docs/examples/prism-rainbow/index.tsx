'use client';

import { useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { Controls } from './controls';
import { createRenderer, type PrismRenderer } from './renderer';
import { DEFAULT_PRISM_CONTROLS, type PrismControls } from './types';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<PrismRenderer | null>(null);
  const [controls, setControls] = useState<PrismControls>(DEFAULT_PRISM_CONTROLS);
  const [accumulated, setAccumulated] = useState(0);

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
    // The estimate refines every frame; polling a few times a second is enough
    // to show it climbing without re-rendering React on the render loop.
    const readout = setInterval(() => setAccumulated(renderer.accumulated()), 250);
    return () => {
      clearInterval(readout);
      rendererRef.current = null;
      renderer.dispose();
    };
  }, [reportError]);

  useEffect(() => rendererRef.current?.setControls?.(controls), [controls]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full cursor-ns-resize touch-none" />
      <Controls value={controls} onChange={setControls} accumulated={accumulated} />
      <div className="pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[.08em] text-white/80">
        drag up or down to swing the lamp
      </div>
    </div>
  );
}
