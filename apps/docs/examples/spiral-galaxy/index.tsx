'use client';

import { useEffect, useRef } from 'react';
import { createRenderer } from './renderer';

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas });
    void renderer.ready;
    return () => renderer.dispose();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        tabIndex={0}
        aria-label="Spiral galaxy star field. Drag or use the arrow keys to rotate it; hover to scatter the stars."
        className="block h-full w-full touch-none outline-none"
      />
    </div>
  );
}

export default Example;
