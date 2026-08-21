'use client';

import { useEffect, useRef } from 'react';
import { createRenderer } from './renderer';

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;
    const pending = createRenderer(canvasRef.current).catch(() => undefined);

    return () => {
      void pending.then((renderer) => renderer?.dispose());
    };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
    </div>
  );
}
