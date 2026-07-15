import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createMockAdapter } from "@vgpu/adapter-mock";

import { Mesh } from "../../../../vgpu-api/src/scene/geometry-src/mesh.ts";
import { bevel, dissolveFaces, extrude, inset, subdivideEdges, toEditable, type EditableMeshValue } from "@vgpu/render/edit";
import { expect, test } from "vitest";

const OUT = "packages/render/perf-baselines/long-pipeline.json";

test("long mesh-edit pipeline stays within loose runtime budget", async () => {
  const device = await createMockAdapter().requestDevice();
  try {
    const startHeap = process.memoryUsage().heapUsed;
    let peakHeap = startHeap, mesh = toEditable(Mesh.box({ device, size: 1 }));
    const rng = random(0x34_07);
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      mesh = applyRandom(mesh, rng);
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    }
    const ms = performance.now() - start;
    const baseline = { version: 1, scenario: "long-pipeline-5ops-100iter", node: process.version, arch: process.arch, ms, heapDeltaBytes: peakHeap - startHeap, capturedAt: new Date().toISOString() };
    if (process.env.VGPU_WRITE_PERF_BASELINES === "1") await writeBaseline(baseline);
    expect(mesh.faceCount).toBeGreaterThan(0);
    expect(ms).toBeLessThan(60_000);
  } finally {
    device.destroy();
  }
});

function applyRandom(mesh: EditableMeshValue, rng: () => number): EditableMeshValue {
  const op = Math.floor(rng() * 5);
  if (op === 0) return extrude(mesh, mesh.faces.byIndex([pick(mesh.faceCount, rng)]), { distance: 0.03 }).mesh;
  if (op === 1) return bevel(mesh, mesh.edges.byIndex([pick(mesh.edgeCount, rng)]), { offset: 0.01 }).mesh;
  if (op === 2) return inset(mesh, mesh.faces.byIndex([pick(mesh.faceCount, rng)]), { thickness: 0.05, depth: 0.01 }).mesh;
  if (op === 3) return subdivideEdges(mesh, mesh.edges.byIndex([pick(mesh.edgeCount, rng)])).mesh;
  return dissolveFaces(mesh, mesh.faces.byIndex([pick(mesh.faceCount, rng)])).mesh;
}

function pick(count: number, rng: () => number): number { return Math.min(count - 1, Math.floor(rng() * count)); }
function random(seed: number): () => number { let s = seed >>> 0; return () => { s = (1664525 * s + 1013904223) >>> 0; return s / 0x1_0000_0000; }; }
async function writeBaseline(data: unknown): Promise<void> { await mkdir(join(process.cwd(), "packages/render/perf-baselines"), { recursive: true }); await writeFile(join(process.cwd(), OUT), `${JSON.stringify(data, null, 2)}\n`); }
