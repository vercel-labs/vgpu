'use client';

import { useEffect, useRef, useState } from 'react';
import { createRenderer } from './renderer';

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let mounted = true;
    const renderer = createRenderer(canvas);
    void renderer.ready.catch((cause: unknown) => {
      if (!mounted) return;
      console.error('Holographic card initialization failed:', cause);
      setError(true);
    });
    return () => { mounted = false; renderer.dispose(); };
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#090a0c]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" aria-label="vgpu. Holographic. Light, computed. Edition 001. WebGPU. A graphite card with a visible triangle outline; hover or drag to reveal its holographic engraving." />
      <p className="pointer-events-none absolute inset-x-0 bottom-5 text-center font-mono text-[10px] tracking-[0.2em] text-white/35">
        {error ? 'This example requires a WebGPU-capable browser.' : 'MOVE TO REVEAL'}
      </p>
    </div>
  );
}

export default Example;
