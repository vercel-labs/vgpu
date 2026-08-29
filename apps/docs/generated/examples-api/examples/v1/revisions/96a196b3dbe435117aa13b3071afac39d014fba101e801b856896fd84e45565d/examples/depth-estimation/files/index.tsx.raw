"use client";

import { useEffect, useRef } from "react";
import { createDepthRenderer } from "./ort-runtime";

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createDepthRenderer(canvas);
    void renderer.ready;
    return () => renderer.dispose();
  }, []);

  return (
    <div className="relative h-full w-full overflow-hidden bg-black p-4">
      <canvas
        ref={canvasRef}
        aria-label="Depth relief rendered from the model's GPU-resident depth tensor"
        className="block h-full w-full rounded-lg border border-gray-4 bg-gray-1"
      />
    </div>
  );
}
