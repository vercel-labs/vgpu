'use client';

import { useEffect, useRef, useState } from 'react';

import { Orb } from './orb';
import { createOrbStore } from './orb-store';
import { createRenderer } from './renderer';

export function Example() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [store] = useState(createOrbStore);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) return;

    const renderer = createRenderer({ canvas, container, store });
    void renderer.ready;

    return () => renderer.dispose();
  }, [store]);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} aria-hidden="true" className="absolute inset-0 block h-full w-full touch-none" />
      <Orb store={store} />
    </div>
  );
}

export default Example;
