"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent } from "react";
import type { DotMapResult } from "@/lib/get-dot-map";

const CELL_PITCH = 38;
const LINES = ["vgpu"];

type DotPosition = {
  readonly x: number;
  readonly y: number;
  readonly id: string;
  readonly isNoise: boolean;
};

function generateNoiseDots(realDots: DotPosition[], cellSizePx: number, noiseCount: number): DotPosition[] {
  const directions: Array<[number, number]> = [];
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      directions.push([dx, dy]);
    }
  }

  const keyFor = (x: number, y: number) => `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
  const realDotSet = new Set(realDots.map((dot) => keyFor(dot.x, dot.y)));

  const shuffled = [...realDots];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }

  const noiseDots: DotPosition[] = [];
  const noiseSet = new Set<string>();

  for (const borderDot of shuffled) {
    const dirs = [...directions];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j]!, dirs[i]!];
    }

    for (const [dx, dy] of dirs) {
      const x = borderDot.x + dx * cellSizePx;
      const y = borderDot.y + dy * cellSizePx;
      const key = keyFor(x, y);

      if (realDotSet.has(key) || noiseSet.has(key)) continue;

      noiseSet.add(key);
      noiseDots.push({
        x,
        y,
        id: `noise-${noiseDots.length}`,
        isNoise: true,
      });

      if (noiseDots.length >= noiseCount) return noiseDots;
      break;
    }
  }

  return noiseDots;
}

function colorSteps(baseColor: string) {
  const br = Number.parseInt(baseColor.slice(1, 3), 16);
  const bg = Number.parseInt(baseColor.slice(3, 5), 16);
  const bb = Number.parseInt(baseColor.slice(5, 7), 16);
  const toHex = (r: number, g: number, b: number) =>
    `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;

  return [
    baseColor,
    toHex(br + ((255 - br) * 1) / 3, bg + ((255 - bg) * 1) / 3, bb + ((255 - bb) * 1) / 3),
    toHex(br + ((255 - br) * 2) / 3, bg + ((255 - bg) * 2) / 3, bb + ((255 - bb) * 2) / 3),
    "#ffffff",
  ];
}

function setDotShape(el: SVGSVGElement, current: number, steps: readonly string[]) {
  let shape: string;
  let stepIndex: number;
  if (current < 0.25) {
    shape = "square";
    stepIndex = 0;
  } else if (current < 0.5) {
    shape = "circle";
    stepIndex = 1;
  } else if (current < 0.75) {
    shape = "dash";
    stepIndex = 2;
  } else {
    shape = "triangle";
    stepIndex = 3;
  }
  el.dataset.shape = shape;
  el.style.setProperty("--dot-color", steps[stepIndex] ?? steps[0] ?? "#878787");
}

export function VgpuPixelHero({ dotMap }: { readonly dotMap: DotMapResult }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lineRefs = useRef<(HTMLDivElement | null)[]>([]);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const dotSvgRefs = useRef<(SVGSVGElement | null)[]>([]);
  const noiseDotSvgRefs = useRef<(SVGSVGElement | null)[]>([]);

  const [dotPositions, setDotPositions] = useState<DotPosition[]>([]);
  const [noiseDots, setNoiseDots] = useState<DotPosition[]>([]);

  const morphValuesRef = useRef<Float32Array>(new Float32Array(0));
  const noiseMorphValuesRef = useRef<Float32Array>(new Float32Array(0));
  const mousePosRef = useRef({ x: -9999, y: -9999 });
  const isMouseMovingRef = useRef(false);
  const mouseStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const paramsRef = useRef({
    hoverRadius: 62,
    dotColor: "#a1a1aa",
    chargeSpeed: 7.5,
    dischargeSpeed: 0.5,
    activeWhenMoving: true,
  });

  const measure = useCallback(async () => {
    const container = containerRef.current;
    if (!container) return;

    if (typeof document !== "undefined" && "fonts" in document) {
      await document.fonts.ready;
    }

    const containerRect = container.getBoundingClientRect();
    const computed = window.getComputedStyle(textLayerRef.current ?? container);
    const measuredFontSize = Number.parseFloat(computed.fontSize) || 120;
    const pxPerUnit = measuredFontSize / dotMap.unitsPerEm;
    const contentHeight = (dotMap.ascent + Math.abs(dotMap.descent)) * pxPerUnit;
    const lineBoxHeight = measuredFontSize * 1;
    const contentTop = (lineBoxHeight - contentHeight) / 2;
    const nextDots: DotPosition[] = [];

    LINES.forEach((line, lineIndex) => {
      const lineEl = lineRefs.current[lineIndex];
      const textNode = Array.from(lineEl?.childNodes ?? []).find((node) => node.nodeType === Node.TEXT_NODE);

      if (!lineEl || !textNode || textNode.nodeType !== Node.TEXT_NODE) return;

      const range = document.createRange();

      line.split("").forEach((char, charIndex) => {
        if (char === " ") return;
        const glyph = dotMap.dotMap[char];
        if (!glyph) return;

        range.setStart(textNode, charIndex);
        range.setEnd(textNode, charIndex + 1);
        const charRect = range.getBoundingClientRect();

        for (let di = 0; di < glyph.dots.length; di++) {
          const [col, row] = glyph.dots[di] ?? [0, 0];
          const unitX = col * CELL_PITCH + CELL_PITCH / 2;
          const unitY = row * CELL_PITCH + CELL_PITCH / 2;
          const screenX = charRect.left + unitX * pxPerUnit - containerRect.left;
          const screenY = charRect.top + contentTop + (dotMap.ascent - unitY) * pxPerUnit - containerRect.top;

          nextDots.push({
            x: screenX,
            y: screenY,
            id: `${lineIndex}-${charIndex}-${di}`,
            isNoise: false,
          });
        }
      });

      range.detach();
    });

    setDotPositions(nextDots);
    const cellSizePx = CELL_PITCH * pxPerUnit;
    const noiseCount = Math.floor(nextDots.length * 0.6);
    setNoiseDots(generateNoiseDots(nextDots, cellSizePx, noiseCount));
  }, [dotMap]);

  useEffect(() => {
    let cancelled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const runMeasure = () => {
      if (!cancelled) void measure();
    };

    const waitForFontsAndMeasure = async () => {
      if (typeof document !== "undefined" && "fonts" in document) {
        await document.fonts.ready;
      }
      requestAnimationFrame(runMeasure);
      setTimeout(runMeasure, 150);
    };

    void waitForFontsAndMeasure();
    const fallback = setTimeout(runMeasure, 500);
    const handleResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(runMeasure, 150);
    };
    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) observer.observe(containerRef.current);

    return () => {
      cancelled = true;
      clearTimeout(fallback);
      if (resizeTimer) clearTimeout(resizeTimer);
      observer.disconnect();
    };
  }, [measure]);

  useEffect(() => {
    if (morphValuesRef.current.length !== dotPositions.length) {
      morphValuesRef.current = new Float32Array(dotPositions.length);
    }
  }, [dotPositions.length]);

  useEffect(() => {
    if (noiseMorphValuesRef.current.length !== noiseDots.length) {
      noiseMorphValuesRef.current = new Float32Array(noiseDots.length);
    }
  }, [noiseDots.length]);

  useEffect(() => {
    if (dotPositions.length === 0) return;

    let rafId = 0;
    let lastTime = performance.now();

    const loop = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const mx = mousePosRef.current.x;
      const my = mousePosRef.current.y;
      const radius = paramsRef.current.hoverRadius * 1.3;
      const chargeSpeed = paramsRef.current.chargeSpeed;
      const dischargeSpeed = paramsRef.current.dischargeSpeed;
      const computedDotColor = getComputedStyle(document.documentElement).getPropertyValue("--hero-dot-color").trim();
      const steps = colorSteps(computedDotColor || paramsRef.current.dotColor);
      const forceDischarge = !paramsRef.current.activeWhenMoving && !isMouseMovingRef.current;

      const svgs = dotSvgRefs.current;
      const morphValues = morphValuesRef.current;
      for (let i = 0; i < svgs.length; i++) {
        const el = svgs[i];
        if (!el) continue;

        const dx = Number.parseFloat(el.style.left) + 2 - mx;
        const dy = Number.parseFloat(el.style.top) + 2 - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const target = forceDischarge ? 0 : 1 - Math.min(dist / radius, 1);

        let current = morphValues[i] ?? 0;
        if (target > current) {
          current = Math.min(current + chargeSpeed * dt, target);
        } else if (target < current) {
          current = Math.max(current - dischargeSpeed * dt, target);
        }
        morphValues[i] = current;
        setDotShape(el, current, steps);
      }

      const noiseSvgs = noiseDotSvgRefs.current;
      const noiseMorphValues = noiseMorphValuesRef.current;
      for (let i = 0; i < noiseSvgs.length; i++) {
        const el = noiseSvgs[i];
        if (!el) continue;

        const dx = Number.parseFloat(el.style.left) + 2 - mx;
        const dy = Number.parseFloat(el.style.top) + 2 - my;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const target = forceDischarge ? 0 : 1 - Math.min(dist / radius, 1);

        let current = noiseMorphValues[i] ?? 0;
        if (target > current) {
          current = Math.min(current + chargeSpeed * dt, target);
        } else if (target < current) {
          current = Math.max(current - dischargeSpeed * dt, target);
        }
        noiseMorphValues[i] = current;
        el.style.opacity = current >= 0.75 ? "1" : "0";
        setDotShape(el, current, steps);
      }

      rafId = requestAnimationFrame(loop);
    };

    rafId = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafId);
  }, [dotPositions.length, noiseDots.length]);

  const setDotRef = useCallback((el: SVGSVGElement | null, index: number) => {
    dotSvgRefs.current[index] = el;
  }, []);

  const setNoiseDotRef = useCallback((el: SVGSVGElement | null, index: number) => {
    noiseDotSvgRefs.current[index] = el;
  }, []);

  const handleMouseMove = useCallback((event: MouseEvent<HTMLDivElement>) => {
    const container = containerRef.current;
    if (!container) return;

    const rect = container.getBoundingClientRect();
    mousePosRef.current = { x: event.clientX - rect.left, y: event.clientY - rect.top };

    if (!paramsRef.current.activeWhenMoving) {
      isMouseMovingRef.current = true;
      if (mouseStopTimerRef.current) clearTimeout(mouseStopTimerRef.current);
      mouseStopTimerRef.current = setTimeout(() => {
        isMouseMovingRef.current = false;
      }, 100);
    }
  }, []);

  const handleMouseLeave = useCallback(() => {
    mousePosRef.current = { x: -9999, y: -9999 };
  }, []);

  const dotStyle = (dot: DotPosition): CSSProperties => ({
    position: "absolute",
    left: dot.x - 2,
    top: dot.y - 2,
    "--dot-color": "var(--hero-dot-color)",
  } as CSSProperties);

  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        ref={containerRef}
        className="pointer-events-auto absolute left-1/2 top-[var(--hero-wordmark-top)] scale-[var(--hero-wordmark-scale)] -translate-x-1/2 -translate-y-1/2"
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      >
        <style>{`
          .dot .square, .dot circle, .dot .dash, .dot polygon {
            opacity: 0;
            fill: var(--dot-color, #878787);
          }
          .dot[data-shape="square"] .square { opacity: 1; }
          .dot[data-shape="circle"] circle { opacity: 1; }
          .dot[data-shape="dash"] .dash { opacity: 1; }
          .dot[data-shape="triangle"] polygon { opacity: 1; }
        `}</style>

        <div
          ref={textLayerRef}
          className="select-none text-center font-pixel text-[clamp(8rem,22vw,18rem)] leading-[0.87] tracking-[-0.03em] text-white/15 opacity-0 transition-opacity duration-150"
        >
          {LINES.map((line, lineIndex) => (
            <div
              key={line}
              ref={(el) => {
                lineRefs.current[lineIndex] = el;
              }}
              className="block whitespace-pre"
            >
              {line}
            </div>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0">
          {dotPositions.map((dot, index) => (
            <svg
              key={dot.id}
              ref={(el) => setDotRef(el, index)}
              className="dot"
              data-shape="square"
              width="4"
              height="4"
              viewBox="0 0 4 4"
              style={dotStyle(dot)}
            >
              <rect className="square" x="0.25" y="0.25" width="3.5" height="3.5" />
              <circle cx="2" cy="2" r="1.75" />
              <rect className="dash" x="0.25" y="1.4" width="3.5" height="1.2" />
              <polygon points="2,0.1 3.8,3.5 0.2,3.5" />
            </svg>
          ))}
        </div>

        <div className="pointer-events-none absolute inset-0">
          {noiseDots.map((dot, index) => (
            <svg
              key={dot.id}
              ref={(el) => setNoiseDotRef(el, index)}
              className="dot noise-dot"
              data-shape="square"
              width="4"
              height="4"
              viewBox="0 0 4 4"
              style={{ ...dotStyle(dot), opacity: 0 }}
            >
              <rect className="square" x="0.25" y="0.25" width="3.5" height="3.5" />
              <circle cx="2" cy="2" r="1.75" />
              <rect className="dash" x="0.25" y="1.4" width="3.5" height="1.2" />
              <polygon points="2,0.1 3.8,3.5 0.2,3.5" />
            </svg>
          ))}
        </div>
      </div>
    </div>
  );
}
