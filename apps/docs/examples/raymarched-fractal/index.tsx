'use client';

import { useEffect, useRef } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { createRenderer } from './renderer';

export function Example() {
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas, onError: reportError });
    void renderer.ready.catch(() => {
      // onError reports initialization failures to the preview host.
    });
    return () => renderer.dispose();
  }, [reportError]);
  return <div className="relative h-full w-full overflow-hidden bg-black"><canvas ref={canvasRef} className="block h-full w-full touch-none" /></div>;
}
