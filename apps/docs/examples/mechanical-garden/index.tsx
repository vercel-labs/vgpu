"use client";

import { useEffect, useRef } from "react";

import { createRenderer } from "./renderer";

export function Example() {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = rootRef.current;
    if (!canvas || !container) return;

    const renderer = createRenderer({ canvas, container });
    void renderer.ready;
    return renderer.dispose;
  }, []);

  return (
    <div ref={rootRef} className="relative h-full w-full overflow-hidden bg-[#808183]">
      <canvas
        ref={canvasRef}
        role="application"
        tabIndex={0}
        className="block h-full w-full touch-none outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:-outline-offset-2 focus-visible:outline-amber-300"
        aria-label="Quadruped robot dogs walking over a sculptable gray training ground. Pick a tool in the tool bar or with keys 1 orbit, 2 elevate, 3 lower, 4 destination. Orbit: drag to orbit, right-drag or Shift-drag to pan. Elevate and lower: drag over the ground to sculpt it. Destination: click the ground to send the dogs there. Scroll or pinch to zoom in every tool. With the canvas focused, arrows move the cursor (or orbit in the orbit tool), hold Enter or Space to sculpt or press it to send the dogs, P pauses and period steps once; while paused, sculpting changes the ground only on each step."
      />
    </div>
  );
}

export default Example;
