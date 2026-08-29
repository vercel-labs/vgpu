"use client";

import { useEffect, useRef, useState } from "react";
import { createRenderer } from "./renderer";

type Shape = "fractal" | "orb";

const SHAPES = [
  { id: "fractal", label: "Fractal", sphereMix: 0 },
  { id: "orb", label: "Orb", sphereMix: 1 },
] as const satisfies readonly {
  id: Shape;
  label: string;
  sphereMix: number;
}[];

export function Example() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<ReturnType<typeof createRenderer>>(null);
  const [shape, setShape] = useState<Shape>("fractal");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const renderer = createRenderer({ canvas });
    rendererRef.current = renderer;
    void renderer.ready.then(() => {
      if (!cancelled) setIsReady(true);
    });
    return () => {
      cancelled = true;
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, []);

  const selectShape = (nextShape: Shape, sphereMix: number) => {
    setShape(nextShape);
    rendererRef.current?.setSphereMix(sphereMix);
  };

  return (
    <div
      className="relative h-full w-full overflow-hidden bg-[#fafafa]"
      style={{
        background:
          "radial-gradient(ellipse at 95% 0%, #eeeeef 0%, #f6f6f6 45%, #fafafa 78%)",
      }}
    >
      <canvas
        ref={canvasRef}
        className={`block h-full w-full touch-none transition-opacity duration-500 ${
          isReady ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        role="group"
        aria-label="Fractal shape"
        className="absolute bottom-5 left-1/2 z-20 flex -translate-x-1/2 rounded-full border border-black/10 bg-white/75 p-1 text-sm shadow-lg backdrop-blur-md"
      >
        {SHAPES.map((option) => {
          const selected = shape === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-pressed={selected}
              onClick={() => selectShape(option.id, option.sphereMix)}
              className={`min-w-20 rounded-full px-4 py-2 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-black ${
                selected
                  ? "bg-black text-white"
                  : "text-black/55 hover:bg-black/5 hover:text-black"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
