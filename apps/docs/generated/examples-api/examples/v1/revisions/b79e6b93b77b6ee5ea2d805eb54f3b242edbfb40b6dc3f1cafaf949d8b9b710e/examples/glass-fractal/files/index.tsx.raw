"use client";

import { useEffect, useRef, useState } from "react";
import { useExampleErrorReporter } from "../../lib/example-error-reporter";
import {
  createHeroFractalRenderer,
  type HeroFractalCamera,
  type HeroFractalGlass,
  type HeroFractalMaterial,
} from "./renderer";

const HERO_FRACTAL_CAMERA = {
  cameraRotation: [0, 0, 0],
  cameraDistance: [5.44, 1.33, 0.55],
  cameraTarget: [0, 0.16, 0],
  fov: 20,
  maxMouseRotation: 5,
  mouseLerp: 0.02,
} satisfies HeroFractalCamera;

const HERO_FRACTAL_MATERIAL = {
  baseColor: [71 / 255, 71 / 255, 71 / 255],
  roughness: 0.24,
  diffuseStrength: 0.19,
  specularStrength: 0.06,
  ambientStrength: 0.34,
} satisfies HeroFractalMaterial;

const HERO_ORB_MATERIAL = {
  baseColor: [1, 1, 1],
  roughness: 0.25,
  diffuseStrength: 0.08,
  specularStrength: 1.6,
  ambientStrength: 0,
} satisfies HeroFractalMaterial;

const HERO_FRACTAL_GLASS = {
  fractalScale: 0.72,
  orbScale: 0.6,
  orbOffsetY: 0.08,
  sphereMix: 0,
  ior: 1.149,
  reflectionStrength: 0.71,
  backOpacity: 0.19,
  absorption: [74 / 255, 74 / 255, 74 / 255],
  frostRadius: 1.8,
  dispersion: 0.025,
  iridescenceStrength: 0.04,
  iridescenceFrequency: 2,
  environmentRotation: [0, -36, 0],
  environmentExposure: 1,
} satisfies HeroFractalGlass;

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
  const reportError = useExampleErrorReporter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef =
    useRef<ReturnType<typeof createHeroFractalRenderer>>(null);
  const [shape, setShape] = useState<Shape>("fractal");
  const [isReady, setIsReady] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const renderer = createHeroFractalRenderer({
      canvas,
      camera: HERO_FRACTAL_CAMERA,
      fractalMaterial: HERO_FRACTAL_MATERIAL,
      orbMaterial: HERO_ORB_MATERIAL,
      glass: HERO_FRACTAL_GLASS,
      onError: (error) => {
        reportError(error);
        if (!cancelled) setIsReady(false);
      },
    });
    rendererRef.current = renderer;

    void renderer.ready
      .then(() => {
        if (!cancelled) setIsReady(true);
      })
      .catch(() => {
        // The example error reporter owns initialization failures.
      });

    return () => {
      cancelled = true;
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer.dispose();
    };
  }, [reportError]);

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
