'use client';

import { useEffect, useRef } from 'react';
import { useExampleErrorReporter } from '../../lib/example-error-reporter';
import { createRenderer } from './renderer';

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const reportError = useExampleErrorReporter();

  useEffect(() => {
    if (!canvasRef.current) return;
    const renderer = createRenderer({ canvas: canvasRef.current, onError: reportError });
    void renderer.ready.catch(() => {});
    return () => renderer.dispose();
  }, [reportError]);

  return <canvas ref={canvasRef} className="block h-full w-full bg-black" />;
}
