import { Texture, type Device } from "@vgpu/core";
import type { RenderTarget, RenderTargetGpu } from "./types.ts";

export interface CanvasRenderTargetOptions {
  readonly label?: string;
  readonly clearColor?: GPUColorDict | readonly [number, number, number, number];
}

const DEFAULT_CLEAR_COLOR = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });
const DEFAULT_FORMAT: GPUTextureFormat = "rgba8unorm";

/**
 * Wraps a GPUCanvasContext in a lazy RenderTarget shape.
 *
 * The `.color` accessor calls `context.getCurrentTexture()` on every access.
 * It is not safe to cache `.color` across frames; the canvas texture becomes
 * invalid after `device.queue.submit`. Re-access `.color` each frame, or rely on
 * pass helpers that read the target lazily.
 */
export function renderTargetForCanvas(context: GPUCanvasContext, options: CanvasRenderTargetOptions = {}): RenderTarget {
  const clearColor = colorDict(options.clearColor);
  const target = {
    get color(): Texture { return canvasTexture(context, options.label); },
    get colors(): readonly [Texture] { return Object.freeze([this.color]) as readonly [Texture]; },
    get depth(): undefined { return undefined; },
    get size(): readonly [number, number] { return canvasSize(context); },
    get format(): GPUTextureFormat { return canvasFormat(context); },
    get sampleCount(): 1 { return 1; },
    get label(): string { return options.label ?? "canvas"; },
    get gpu(): RenderTargetGpu {
      const texture = context.getCurrentTexture();
      return Object.freeze({
        colorAttachment: { view: texture.createView(), loadOp: "clear" as const, storeOp: "store" as const, clearValue: clearColor },
        colorTexture: texture,
      });
    },
  } satisfies RenderTarget;
  return Object.freeze(target);
}

function canvasTexture(context: GPUCanvasContext, label: string | undefined): Texture {
  const texture = context.getCurrentTexture();
  return new Texture({} as Device, texture, {
    size: canvasSize(context),
    format: canvasFormat(context),
    usage: ["render_attachment"],
    label: label ? `${label}.color` : "canvas.color",
  });
}

function canvasSize(context: GPUCanvasContext): readonly [number, number] {
  const canvas = context.canvas as { width: number; height: number };
  return [canvas.width, canvas.height] as const;
}

function canvasFormat(context: GPUCanvasContext): GPUTextureFormat {
  const configured = (context as { getConfiguration?: () => { format?: GPUTextureFormat } | undefined }).getConfiguration?.();
  return configured?.format ?? DEFAULT_FORMAT;
}

function colorDict(color: CanvasRenderTargetOptions["clearColor"]): GPUColorDict {
  if (!color) return DEFAULT_CLEAR_COLOR;
  if (Array.isArray(color)) return { r: color[0], g: color[1], b: color[2], a: color[3] };
  return color as GPUColorDict;
}
