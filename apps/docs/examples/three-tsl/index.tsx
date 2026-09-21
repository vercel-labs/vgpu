"use client";

import { useEffect, useRef, useState } from "react";
import { createRenderer } from "./renderer";

export function Example() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [hintVisible, setHintVisible] = useState(true);

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
        onPointerDown={() => setHintVisible(false)}
        className="block h-full w-full touch-none"
      />
      <div
        className={`pointer-events-none absolute bottom-[18px] left-1/2 z-[2] -translate-x-1/2 text-xs font-medium uppercase tracking-[0.08em] text-white/80 transition-opacity duration-[400ms] ${
          hintVisible ? "opacity-100" : "opacity-0"
        }`}
      >
        drag to orbit
      </div>
    </div>
  );
}

export default Example;
