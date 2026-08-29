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
    <div className="relative h-full w-full overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <div
        className={
          "pointer-events-none absolute bottom-[18px] left-1/2 z-[2] " +
          "-translate-x-1/2 text-xs font-medium uppercase tracking-[.08em] text-white/80"
        }
      >
        draw light
      </div>
    </div>
  );
}
