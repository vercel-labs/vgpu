'use client';

import { useEffect, useRef } from 'react';
import { createRenderer } from './renderer';

export function Example() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;
    const renderer = createRenderer({ canvas, container });
    void renderer.ready;
    return () => renderer.dispose();
  }, []);

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden bg-black"
    >
      <canvas
        ref={canvasRef}
        tabIndex={0}
        role="application"
        aria-label="Kinetic sculpture: a brass mobile of nested arms, pendants and rings. Drag or use the arrow keys to orbit; scroll, pinch or press plus and minus to zoom."
        className="block h-full w-full touch-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-white/50"
      />
    </div>
  );
}

export default Example;
