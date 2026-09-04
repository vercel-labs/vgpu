import { frame as createFrame, target as createTarget, type Frame, type Gpu } from 'vgpu';
import {
  CLOUD_CONVERGENCE_FRAMES, applyState, bakeLuts, createGraph, destroyGraph, encodeAerial, encodeClouds, encodeFrameConstants, encodePresent,
  encodeCloudShadow, encodeScene, encodeSkyView, encodeSunShadow, finishFrame, renderGraph,
} from './renderer';
import { DEFAULT_PRESET, PRESETS } from './tuning';

export interface BenchRow { readonly pass: string; readonly size: string; readonly ms: number }

/** "battery" or "charging" when the browser exposes the Battery API: laptop GPUs clock down unplugged, so numbers only compare within one power state. */
export async function powerState(): Promise<string> {
  const battery = await (navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean }> }).getBattery?.().catch(() => undefined);
  return battery === undefined ? 'unknown power' : battery.charging ? 'charging' : 'battery';
}

const PASS_FRAMES = 24;
const WARMUP_FRAMES = 4;
/** Each row is the best of this many repetitions: GPU clocks drift with load, and the minimum is the stable estimate. */
const REPEATS = 3;

/**
 * Per-pass cost of one frame on this GPU, at the default preset, for each device pixel ratio. Each row submits frames
 * that encode a single pass, back to back with one wait for the queue, and reports the best wall clock per frame of a
 * few repetitions; the rows add up to the full frame within noise. Skipped passes leave stale inputs behind, which is fine: no pass does less work
 * because another one did not run. GPU timestamps were tried instead and rejected: on Apple GPUs the passes of a frame
 * overlap, so a pass timestamp pair spans the work of its predecessors too.
 */
export async function runBench(gpu: Gpu, cssSize: readonly [number, number], dprs: readonly number[] = [1.5, 1]): Promise<BenchRow[]> {
  const rows: BenchRow[] = [];
  const queue = gpu.gpu.queue;
  const preset = PRESETS[DEFAULT_PRESET];
  for (const dpr of dprs) {
    const size = [Math.max(1, Math.round(cssSize[0] * dpr)), Math.max(1, Math.round(cssSize[1] * dpr))] as const;
    const label = `${size[0]}x${size[1]} (dpr ${dpr})`;
    const output = createTarget(gpu, { size, format: 'rgba8unorm', label: 'atmosphere-bench' });
    const graph = await createGraph(gpu, output, 'atmosphere-bench');
    graph.accumulate = true;
    applyState(graph, preset, size);
    bakeLuts(gpu, graph);
    createFrame(gpu, (frame) => encodeSkyView(frame, graph));
    for (let i = 0; i < CLOUD_CONVERGENCE_FRAMES; i++) createFrame(gpu, (frame) => renderGraph(frame, graph, output));
    await queue.onSubmittedWorkDone();

    const time = async (pass: string, submit: () => void): Promise<void> => {
      let best = Infinity;
      for (let repeat = 0; repeat < REPEATS; repeat++) {
        for (let i = 0; i < WARMUP_FRAMES; i++) submit();
        await queue.onSubmittedWorkDone();
        const start = performance.now();
        for (let i = 0; i < PASS_FRAMES; i++) submit();
        await queue.onSubmittedWorkDone();
        best = Math.min(best, (performance.now() - start) / PASS_FRAMES);
      }
      rows.push({ pass, size: label, ms: best });
    };
    const passFrame = (encode: (frame: Frame) => void) => () => createFrame(gpu, encode);
    const cloudsFrame = passFrame((frame) => { encodeClouds(frame, graph); finishFrame(graph); });

    await time('full frame', passFrame((frame) => renderGraph(frame, graph, output)));
    await time('scene: terrain depth + shading + sky', passFrame((frame) => encodeScene(frame, graph)));
    await time('clouds: 1/16 of the texels marched', cloudsFrame);
    applyState(graph, { ...preset, cloudCoverage: 0 }, size);
    await time('clouds: coverage 0, resolve only', cloudsFrame);
    applyState(graph, preset, size);
    graph.cloudChangeFrames = Number.POSITIVE_INFINITY;
    await time('clouds: every texel marched (after a change)', cloudsFrame);
    graph.cloudChangeFrames = 0;
    await time('luts: aerial + frame constants + sky-view', passFrame((frame) => { encodeAerial(graph); encodeFrameConstants(graph); encodeSkyView(frame, graph); }));
    await time('present: tonemap + cloud upsample', passFrame((frame) => encodePresent(frame, graph, output)));
    await time('sun shadow map (only when the sun moves)', passFrame((frame) => { graph.bakedSunDirection = undefined; encodeSunShadow(frame, graph); }));
    await time('cloud shadow map (every frame)', () => encodeCloudShadow(graph));
    destroyGraph(graph);
    output.color.destroy();
  }
  console.log(`atmosphere bench, ${await powerState()}`);
  console.table(rows);
  return rows;
}

/** Prints the rows over the canvas so the numbers are readable without devtools, headed by the power state they were taken in. */
export async function mountBenchReport(canvas: HTMLCanvasElement, rows: readonly BenchRow[]): Promise<void> {
  const pre = document.createElement('pre');
  const width = Math.max(...rows.map((row) => row.pass.length));
  const lines = rows.map((row) => `${row.pass.padEnd(width)}  ${row.size.padEnd(20)}  ${row.ms.toFixed(2).padStart(6)} ms`);
  pre.textContent = [`ms per frame, best of ${REPEATS} x ${PASS_FRAMES} frames, ${await powerState()}`, ...lines].join('\n');
  pre.dataset['atmosphereBench'] = JSON.stringify(rows);
  Object.assign(pre.style, {
    position: 'absolute', left: '16px', bottom: '16px', zIndex: '2', margin: '0', padding: '10px 12px', borderRadius: '10px',
    background: 'rgba(5, 8, 22, 0.8)', color: 'white', font: '11px/1.4 ui-monospace, Menlo, monospace', pointerEvents: 'none',
  });
  (canvas.parentElement ?? document.body).append(pre);
}
