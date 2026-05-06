import type { Device } from "@vgpu/core";
import { RenderPass } from "./render-pass.ts";

export interface DrawSpec {
  /** Compiled render pipeline. Required. */
  readonly pipeline: GPURenderPipeline;

  /** Render target view to render into. Required. */
  readonly target: GPUTextureView;

  /** Number of vertices to draw. Required. */
  readonly vertexCount: number;

  /** Optional clear color. Defaults to opaque black [0,0,0,1] when omitted. */
  readonly clearValue?: GPUColor;
}

export class RapidRenderer {
  constructor(private readonly device: Device) {}

  get gpu(): GPUDevice {
    return this.device.gpu;
  }

  async draw(spec: DrawSpec): Promise<void> {
    const pass = new RenderPass(this.device, {
      colorAttachments: [
        {
          view: spec.target,
          loadOp: "clear",
          storeOp: "store",
          clearValue: colorTuple(spec.clearValue),
        },
      ],
    });
    pass.setPipeline(spec.pipeline);
    pass.draw({ vertexCount: spec.vertexCount });
    pass.end();
  }
}

function colorTuple(color: GPUColor | undefined): readonly [number, number, number, number] {
  if (!color) return [0, 0, 0, 1];
  if (isIterableColor(color)) {
    const values = Array.from(color);
    return [values[0] ?? 0, values[1] ?? 0, values[2] ?? 0, values[3] ?? 1];
  }
  return [color.r, color.g, color.b, color.a];
}

function isIterableColor(color: GPUColor): color is Iterable<number> {
  return Symbol.iterator in Object(color);
}
