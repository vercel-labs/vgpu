"use client";

import { useEffect, useRef } from "react";
import { createHeroRenderer } from "./hero-renderer";

export function HeroBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const pending = createHeroRenderer(canvas).catch((error: unknown) => {
      console.error("hero background unavailable", error);
      return undefined;
    });
    return () => {
      void pending.then((renderer) => renderer?.dispose());
    };
  }, []);

  return <canvas ref={canvasRef} aria-hidden="true" />;
}
