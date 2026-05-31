"use client";

import { useEffect, useRef } from "react";

function drawRoundedRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + width, y, x + width, y + height, r);
  ctx.arcTo(x + width, y + height, x, y + height, r);
  ctx.arcTo(x, y + height, x, y, r);
  ctx.arcTo(x, y, x + width, y, r);
  ctx.closePath();
}

function drawWorkflow(ctx: CanvasRenderingContext2D, width: number, height: number, dpr: number) {
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.scale(dpr, dpr);

  const w = width / dpr;
  const h = height / dpr;
  const cx = w / 2;
  const cy = h / 2 + 8;
  const nodeRadius = Math.min(w, h) * 0.125;
  const cardW = Math.min(240, w * 0.32);
  const cardH = 74;
  const pad = Math.max(24, Math.min(44, w * 0.06));

  const nodes = [
    { x: pad + cardW / 2, y: pad + cardH / 2 },
    { x: w - pad - cardW / 2, y: pad + cardH / 2 },
    { x: pad + cardW / 2, y: h - pad - cardH / 2 },
    { x: w - pad - cardW / 2, y: h - pad - cardH / 2 },
  ];

  const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.58);
  bg.addColorStop(0, "rgba(255,255,255,0.13)");
  bg.addColorStop(0.28, "rgba(255,255,255,0.045)");
  bg.addColorStop(0.74, "rgba(255,255,255,0.01)");
  bg.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = "rgba(255,255,255,0.18)";
  ctx.lineWidth = 1;
  for (let x = 0.5; x < w; x += 42) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let y = 0.5; y < h; y += 42) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (const [index, node] of nodes.entries()) {
    const gradient = ctx.createLinearGradient(node.x, node.y, cx, cy);
    gradient.addColorStop(0, "rgba(255,255,255,0.38)");
    gradient.addColorStop(0.45, "rgba(255,255,255,0.18)");
    gradient.addColorStop(1, "rgba(255,255,255,0.02)");

    ctx.strokeStyle = gradient;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    const controlX = index % 2 === 0 ? cx - w * 0.12 : cx + w * 0.12;
    const controlY = index < 2 ? cy - h * 0.18 : cy + h * 0.18;
    ctx.moveTo(node.x, node.y);
    ctx.quadraticCurveTo(controlX, controlY, cx, cy);
    ctx.stroke();

    ctx.fillStyle = index < 2 ? "rgba(255,255,255,0.75)" : "rgba(255,255,255,0.48)";
    ctx.beginPath();
    ctx.arc(node.x, node.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }

  for (let i = 0; i < 8; i++) {
    const radius = nodeRadius + i * 16;
    ctx.strokeStyle = `rgba(255,255,255,${0.09 - i * 0.008})`;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, nodeRadius * 2.25);
  glow.addColorStop(0, "rgba(255,255,255,0.42)");
  glow.addColorStop(0.34, "rgba(255,255,255,0.13)");
  glow.addColorStop(0.7, "rgba(255,255,255,0.035)");
  glow.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, nodeRadius * 2.25, 0, Math.PI * 2);
  ctx.fill();

  const metal = ctx.createRadialGradient(cx - nodeRadius * 0.38, cy - nodeRadius * 0.44, nodeRadius * 0.05, cx, cy, nodeRadius);
  metal.addColorStop(0, "rgba(255,255,255,0.95)");
  metal.addColorStop(0.16, "rgba(255,255,255,0.46)");
  metal.addColorStop(0.36, "rgba(180,180,180,0.15)");
  metal.addColorStop(0.7, "rgba(12,12,12,0.98)");
  metal.addColorStop(1, "rgba(0,0,0,1)");

  ctx.fillStyle = metal;
  ctx.beginPath();
  ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.24)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, nodeRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.globalAlpha = 0.58;
  ctx.strokeStyle = "rgba(255,255,255,0.42)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(cx - nodeRadius * 0.62, cy + nodeRadius * 0.1);
  ctx.quadraticCurveTo(cx, cy + nodeRadius * 0.42, cx + nodeRadius * 0.62, cy - nodeRadius * 0.08);
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const node of nodes) {
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.58)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 14;
    drawRoundedRect(ctx, node.x - cardW / 2, node.y - cardH / 2, cardW, cardH, 18);
    ctx.fillStyle = "rgba(5,5,5,0.72)";
    ctx.fill();
    ctx.restore();

    drawRoundedRect(ctx, node.x - cardW / 2, node.y - cardH / 2, cardW, cardH, 18);
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  ctx.restore();
}

export function WorkflowCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.floor(rect.width * dpr));
      const height = Math.max(1, Math.floor(rect.height * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      const ctx = canvas.getContext("2d");
      if (ctx) drawWorkflow(ctx, width, height, dpr);
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(canvas);
    window.addEventListener("resize", draw);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", draw);
    };
  }, []);

  return <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden="true" />;
}
