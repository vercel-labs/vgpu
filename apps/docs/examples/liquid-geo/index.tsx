"use client";

import { useEffect, useRef, useState } from "react";

import { createRenderer } from "./renderer";

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer>>(null);
  const [shape, setShape] = useState<"liquid" | "earth">("liquid");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas });
    rendererRef.current = renderer;
    void renderer.ready;
    return () => {
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  const selectShape = (nextShape: "liquid" | "earth") => {
    setShape(nextShape);
    rendererRef.current?.setEarthMix(nextShape === "earth" ? 1 : 0);
  };

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#d1d4d8]">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <div className="pointer-events-none absolute bottom-[76px] left-1/2 z-[2] -translate-x-1/2 whitespace-nowrap text-[11px] font-medium uppercase tracking-[.16em] text-zinc-700/70">
        move to shape
      </div>
      <div
        role="group"
        aria-label="Liquid Geo shape"
        className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 rounded-full border border-black/10 bg-white/75 p-1 text-sm shadow-lg backdrop-blur-md"
      >
        {(["liquid", "earth"] as const).map((option) => {
          const selected = shape === option;
          return (
            <button
              key={option}
              type="button"
              aria-pressed={selected}
              onClick={() => selectShape(option)}
              className={`min-w-20 rounded-full px-4 py-2 capitalize transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black ${
                selected
                  ? "bg-zinc-900 text-white"
                  : "text-black/55 hover:bg-black/5 hover:text-black"
              }`}
            >
              {option}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default Example;
