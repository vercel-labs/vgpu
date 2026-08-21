'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { createRenderer } from './renderer';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hintVisible, setHintVisible] = useState(true);
  const hideHint = useCallback(() => setHintVisible(false), []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas, onError: reportError });
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });
    return () => renderer.dispose();
  }, [reportError]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} onPointerDown={hideHint} className="block h-full w-full touch-none" />
      <div
        className={`pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[0.08em] text-white/80 transition-opacity duration-[400ms] ${hintVisible ? 'opacity-100' : 'opacity-0'}`}
      >
        drag to look around
      </div>
    </div>
  );
}
