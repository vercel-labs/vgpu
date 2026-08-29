"use client";

import { useEffect, useRef } from "react";

import { createRenderer } from "./renderer";

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
    <div className="relative h-full w-full overflow-hidden bg-black p-4">
      <canvas
        ref={canvasRef}
        aria-label="Mirrored camera view behind frosted glass, wiped clear by either hand"
        className="block h-full w-full rounded-lg border border-gray-4 bg-gray-1"
      />
    </div>
  );
}
