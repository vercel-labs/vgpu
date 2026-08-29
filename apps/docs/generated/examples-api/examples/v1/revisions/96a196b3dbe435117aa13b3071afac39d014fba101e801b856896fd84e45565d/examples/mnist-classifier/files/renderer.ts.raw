import type { Buffer, Gpu, Surface, Target } from "vgpu";
import { effect as createEffect, frame as runFrame } from "vgpu";
import visualizeWgsl from "./visualize.wgsl";

function asWriteData(view: Float32Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    view.buffer as ArrayBuffer,
    view.byteOffset,
    view.byteLength
  );
}

export function createChart(gpu: Gpu, label = "mnist-classifier") {
  const effect = createEffect(gpu, visualizeWgsl, {
    label: `${label}-visualize`,
  });
  return (
    currentGpu: Gpu,
    output: Surface | Target,
    logits: Buffer,
    hasResult: boolean
  ) => {
    effect.set({
      uniforms: { resolution: output.size, has_result: hasResult ? 1 : 0 },
      logits,
    });
    runFrame(currentGpu, (frame) =>
      frame.pass({ target: output }, (pass) => pass.draw(effect))
    );
  };
}

export function createLogitsBuffer(
  gpu: Gpu,
  label = "mnist-classifier"
): Buffer {
  return gpu.device.createBuffer({
    size: 40,
    usage: ["storage", "copy_dst"],
    label: `${label}-logits`,
  });
}

export function writeLogits(buffer: Buffer, logits: Float32Array): void {
  buffer.write(asWriteData(logits));
}
