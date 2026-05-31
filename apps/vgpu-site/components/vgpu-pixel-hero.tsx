"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const pixelLetters = {
  v: [
    [0, 0], [6, 0],
    [0, 1], [6, 1],
    [1, 2], [5, 2],
    [1, 3], [5, 3],
    [2, 4], [4, 4],
    [2, 5], [4, 5],
    [3, 6],
  ],
  g: [
    [1, 0], [2, 0], [3, 0], [4, 0],
    [0, 1], [5, 1],
    [0, 2],
    [0, 3], [3, 3], [4, 3], [5, 3],
    [0, 4], [5, 4],
    [1, 5], [2, 5], [3, 5], [5, 5],
    [4, 6], [5, 6],
  ],
  p: [
    [0, 0], [1, 0], [2, 0], [3, 0],
    [0, 1], [4, 1],
    [0, 2], [4, 2],
    [0, 3], [1, 3], [2, 3], [3, 3],
    [0, 4],
    [0, 5],
    [0, 6],
  ],
  u: [
    [0, 0], [5, 0],
    [0, 1], [5, 1],
    [0, 2], [5, 2],
    [0, 3], [5, 3],
    [0, 4], [5, 4],
    [0, 5], [5, 5],
    [1, 6], [2, 6], [3, 6], [4, 6],
  ],
} satisfies Record<string, readonly (readonly [number, number])[]>;

type Dot = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly delay: number;
};

type Phase = "reveal" | "hover" | "burst" | "dissolve";

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function easeOutCubic(value: number) {
  return 1 - Math.pow(1 - clamp(value, 0, 1), 3);
}

function buildDots(cell: number, pitch: number, dotSize: number) {
  const word = ["v", "g", "p", "u"] as const;
  const glyphWidth = 7 * cell;
  const wordWidth = pitch * (word.length - 1) + glyphWidth;
  const wordHeight = 7 * cell;

  const dots = word.flatMap((letter, letterIndex) =>
    pixelLetters[letter].map(([col, row]) => {
      const x = letterIndex * pitch + col * cell + dotSize / 2;
      const y = row * cell + dotSize / 2;
      const dx = x - wordWidth / 2;
      const dy = y - wordHeight / 2;
      const distance = Math.hypot(dx, dy);

      return {
        id: `${letter}-${letterIndex}-${col}-${row}`,
        x,
        y,
        delay: distance / Math.max(wordWidth, wordHeight),
      };
    }),
  );

  return { dots, wordWidth, wordHeight };
}

function drawRoundedSquare(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  radius: number,
) {
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, radius);
  ctx.fill();
}

export function VgpuPixelHero({
  onSubmit,
}: {
  readonly onSubmit?: () => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const mouseRef = useRef({ x: -9999, y: -9999, active: false });
  const phaseRef = useRef<Phase>("reveal");
  const phaseStartRef = useRef(0);
  const [value, setValue] = useState("");

  const metrics = useMemo(() => ({
    cell: 18,
    dotSize: 10,
    pitch: 142,
    pad: 92,
  }), []);

  const dotModel = useMemo(
    () => buildDots(metrics.cell, metrics.pitch, metrics.dotSize),
    [metrics.cell, metrics.dotSize, metrics.pitch],
  );

  const setPhase = useCallback((phase: Phase) => {
    phaseRef.current = phase;
    phaseStartRef.current = performance.now();
  }, []);

  useEffect(() => {
    setPhase("reveal");
  }, [setPhase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const shell = shellRef.current;
    if (!canvas || !shell) return;

    let animationFrame = 0;
    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    const canvasElement = canvas;
    const shellElement = shell;
    const ctx = context;

    function resize() {
      const rect = shellElement.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      canvasElement.width = Math.max(1, Math.round(rect.width * dpr));
      canvasElement.height = Math.max(1, Math.round(rect.height * dpr));
      canvasElement.style.width = `${rect.width}px`;
      canvasElement.style.height = `${rect.height}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function render(now: number) {
      const rect = shellElement.getBoundingClientRect();
      const width = rect.width;
      const height = rect.height;
      const { dots, wordWidth, wordHeight } = dotModel;
      const scale = Math.min(1, (width - 18) / wordWidth);
      const scaledWordWidth = wordWidth * scale;
      const scaledWordHeight = wordHeight * scale;
      const scaledDotSize = metrics.dotSize * scale;
      const originX = (width - scaledWordWidth) / 2;
      const originY = (height - scaledWordHeight) / 2;
      const phase = phaseRef.current;
      const elapsed = (now - phaseStartRef.current) / 1000;
      const dissolve = phase === "dissolve" ? easeOutCubic(elapsed / 0.9) : 0;
      const burst = phase === "burst" ? 1 - easeOutCubic(elapsed / 0.85) : 0;

      ctx.clearRect(0, 0, width, height);

      const gradient = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.52);
      gradient.addColorStop(0, "rgba(255,255,255,0.13)");
      gradient.addColorStop(0.42, "rgba(255,255,255,0.035)");
      gradient.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, width, height);

      for (const dot of dots) {
        const baseProgress = easeOutCubic((elapsed - dot.delay * 0.85) / 0.9);
        const dx = originX + dot.x * scale - mouseRef.current.x;
        const dy = originY + dot.y * scale - mouseRef.current.y;
        const distance = Math.hypot(dx, dy);
        const hoverForce = mouseRef.current.active ? clamp(1 - distance / 92, 0, 1) : 0;
        const centerX = dot.x - wordWidth / 2;
        const centerY = dot.y - wordHeight / 2;
        const angle = Math.atan2(centerY, centerX);
        const dissolveDistance = dissolve * 110;
        const burstDistance = burst * 24;
        const hoverDistance = hoverForce * 16;
        const jitter = Math.sin(now / 180 + dot.x * 0.06 + dot.y * 0.04) * hoverForce * 2.4;
        const x = originX + dot.x * scale + Math.cos(angle) * dissolveDistance + (dx / Math.max(distance, 1)) * hoverDistance + jitter;
        const y = originY + dot.y * scale + Math.sin(angle) * dissolveDistance + (dy / Math.max(distance, 1)) * hoverDistance + burstDistance * Math.sin(dot.x * 0.04);
        const opacity = clamp(baseProgress * (1 - dissolve * 0.88), 0, 1);
        const size = scaledDotSize * (0.62 + baseProgress * 0.38 + hoverForce * 0.24 + burst * 0.18);

        ctx.shadowColor = `rgba(255,255,255,${0.18 + hoverForce * 0.28 + burst * 0.24})`;
        ctx.shadowBlur = 12 + hoverForce * 22 + burst * 18;
        ctx.fillStyle = `rgba(245,245,242,${opacity})`;
        drawRoundedSquare(ctx, x - size / 2, y - size / 2, size, 2);
      }

      ctx.shadowBlur = 0;
      animationFrame = requestAnimationFrame(render);
    }

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(shell);
    animationFrame = requestAnimationFrame(render);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrame);
    };
  }, [dotModel, metrics.dotSize]);

  return (
    <div className="flex w-full flex-col items-center gap-tab-8">
      <div
        ref={shellRef}
        className="relative h-[160px] w-[min(92vw,720px)] overflow-visible md:h-[220px] md:w-[760px] lg:w-[820px]"
        aria-hidden="true"
        onMouseMove={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          mouseRef.current = {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
            active: true,
          };
        }}
        onMouseLeave={() => {
          mouseRef.current = { x: -9999, y: -9999, active: false };
        }}
      >
        <div className="absolute inset-0 grid place-items-center font-pixel text-[86px] leading-none tracking-[-0.03em] text-foreground/[0.06] md:text-[128px] lg:text-[148px]">
          vgpu
        </div>
        <canvas ref={canvasRef} className="absolute inset-0" />
      </div>

      <form
        className="flex h-10 w-[276px] max-w-[90vw] items-center rounded-[6px] bg-[#0a0a0a] outline outline-1 outline-white/15 transition focus-within:outline-white/45"
        onSubmit={(event) => {
          event.preventDefault();
          setPhase("dissolve");
          window.setTimeout(() => setPhase("reveal"), 1050);
          setValue("");
          onSubmit?.();
        }}
      >
        <label className="sr-only" htmlFor="vgpu-hero-question">
          Ask about VGPU
        </label>
        <input
          id="vgpu-hero-question"
          className="h-full min-w-0 flex-1 bg-transparent px-3 font-mono text-[14px] leading-[22px] text-foreground outline-none placeholder:text-muted-foreground/70"
          value={value}
          placeholder="Ask about VGPU..."
          onChange={(event) => setValue(event.target.value)}
          onFocus={() => setPhase("burst")}
          onBlur={() => {
            if (phaseRef.current === "burst") setPhase("hover");
          }}
        />
      </form>
    </div>
  );
}
