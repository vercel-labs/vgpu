import { compute, type Buffer, type Gpu } from "vgpu";
import { COUNT, EXPECTED, numericMatch } from "./fixtures.ts";

const WGSL = `
@group(0) @binding(0) var<storage, read> source: array<f32>;
@group(0) @binding(1) var<storage, read_write> destination: array<f32>;
@compute @workgroup_size(16)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x < 16u) { destination[id.x] = source[id.x] * 2.0 + 0.25; }
}`;
export type Mode = "snapshot" | "reference";
export interface PipelineEvidence { mode: Mode; actual: number[]; expected: number[]; numericMatch: boolean; rawIdentity: boolean; copyCount: number; lifecycle: string[] }

export async function runPipeline(gpu: Gpu, raw: GPUBuffer, mode: Mode): Promise<PipelineEvidence> {
  const bytes = COUNT * 4;
  const lifecycle = ["tensor-retained"];
  let source: Buffer | undefined;
  let snapshot: Buffer | undefined;
  let copyCount = 0;
  try {
    if (mode === "reference") {
      source = gpu.device.wrapBuffer(raw);
      lifecycle.push("wrapper-created");
    } else {
      snapshot = gpu.device.createBuffer({ size: bytes, usage: ["storage", "copy_dst"], label: "ort-snapshot" });
      const encoder = gpu.gpu.createCommandEncoder({ label: "ort-snapshot-copy" });
      encoder.copyBufferToBuffer(raw, 0, snapshot.gpu, 0, bytes);
      copyCount++;
      gpu.gpu.queue.submit([encoder.finish()]);
      lifecycle.push("snapshot-copy-submitted");
      source = snapshot;
    }
    const destination = gpu.device.createBuffer({ size: bytes, usage: ["storage", "copy_src"], label: `ort-${mode}-result` });
    try {
      const consumer = compute(gpu, WGSL, { label: `ort-${mode}-consumer` });
      consumer.set({ source, destination });
      consumer.dispatch(1);
      lifecycle.push("consumer-submitted");
      await gpu.device.queue.flush();
      lifecycle.push("queue-flushed");
      const actual = Array.from(new Float32Array(await destination.read(bytes)));
      return { mode, actual, expected: EXPECTED, numericMatch: numericMatch(actual), rawIdentity: mode === "reference" ? source.gpu === raw : source.gpu !== raw, copyCount, lifecycle };
    } finally { destination.dispose(); lifecycle.push("destination-disposed"); }
  } finally {
    if (mode === "reference") { source?.dispose(); lifecycle.push("wrapper-disposed"); }
    snapshot?.dispose();
  }
}
