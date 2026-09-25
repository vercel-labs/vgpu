'use client';

import { useEffect, useRef } from 'react';

import { createRenderer } from './renderer';

export function Example() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) return;

    const renderer = createRenderer({ canvas, container });
    void renderer.ready;

    return () => renderer.dispose();
  }, []);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-black">
      <canvas
        ref={canvasRef}
        role="img"
        aria-label="A swarm of up to a million particles morphing on Motion springs between a triangle, a planet, a torus knot, a galaxy and a wave field. Move the pointer to push them aside; click to send a spring burst through them."
        className="block h-full w-full touch-none"
      />
    </div>
  );
}

export default Example;
