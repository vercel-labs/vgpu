import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Gpu, Target } from 'vgpu';
import {
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_FRAME_COUNT,
} from './fixtures';
import {
  BRUSH_BUFFER_BYTES,
  BRUSH_TUNING,
  DITHER_CELL_LOGICAL_PX,
  KEYPOINT_BUFFER_BYTES,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_TEXELS,
  MASK_WIDTH,
  HAND_EXTRAPOLATION,
  maxJumpDistance,
} from './pose-contract';
import { renderThumbnail, THUMB_DT } from './renderer';

const here = dirname(fileURLToPath(import.meta.url));

interface Recorded {
  readonly dispatches: { label: string; workgroups: number; uniforms: Record<string, unknown> }[];
  readonly draws: string[];
  readonly buffers: { label: string; size: number; destroyed: boolean }[];
  readonly textures: { label: string; size: readonly number[]; destroyed: boolean }[];
  readonly writes: { label: string; bytes: number }[];
  readonly textureWrites: { bytes: number; width: number; height: number }[];
  readonly compositeUniforms: Record<string, unknown>[];
  settled: number;
  submitted: number;
}

function createFakeGpu(options: { failComposite?: boolean } = {}) {
  const recorded: Recorded = {
    dispatches: [],
    draws: [],
    buffers: [],
    textures: [],
    writes: [],
    textureWrites: [],
    compositeUniforms: [],
    settled: 0,
    submitted: 0,
  };

  const makeBuffer = (opts: { size: number; label?: string }) => {
    const entry = { label: opts.label ?? '', size: opts.size, destroyed: false };
    recorded.buffers.push(entry);
    return {
      gpu: { size: opts.size },
      size: opts.size,
      write(data: Uint8Array) {
        recorded.writes.push({ label: entry.label, bytes: data.byteLength });
      },
      dispose() {
        entry.destroyed = true;
      },
    };
  };

  const makeCompute = (label: string) => {
    let uniforms: Record<string, unknown> = {};
    return {
      set(values: Record<string, unknown>) {
        uniforms = (values.uniforms as Record<string, unknown>) ?? {};
        return this;
      },
      dispatch(x: number) {
        recorded.dispatches.push({ label, workgroups: x, uniforms });
      },
    };
  };

  const gpu = {
    device: {
      createBuffer: (opts: { size: number; label?: string }) => makeBuffer(opts),
      createTexture: (opts: { size: readonly number[]; label?: string }) => {
        const entry = { label: opts.label ?? '', size: opts.size, destroyed: false };
        recorded.textures.push(entry);
        return {
          gpu: { marker: entry.label },
          createView: () => ({}),
          destroy() {
            entry.destroyed = true;
          },
        };
      },
    },
    gpu: {
      queue: {
        writeTexture: (
          _dest: unknown,
          data: Uint8Array,
          _layout: unknown,
          size: { width: number; height: number },
        ) => {
          recorded.textureWrites.push({
            bytes: data.byteLength,
            width: size.width,
            height: size.height,
          });
        },
        copyExternalImageToTexture: vi.fn(),
        onSubmittedWorkDone: async () => {
          recorded.submitted++;
        },
      },
    },
    sampler: () => ({ marker: 'sampler' }),
    compute: (_source: string, opts: { label?: string }) => makeCompute(opts.label ?? 'compute'),
    effect: (_source: string, opts: { label?: string }) => ({
      label: opts.label ?? 'effect',
      set(values: Record<string, unknown>) {
        recorded.compositeUniforms.push((values.uniforms as Record<string, unknown>) ?? {});
        return this;
      },
    }),
    frame: (cb: (frame: unknown) => void) => {
      cb({
        pass: (_opts: unknown, body: (pass: unknown) => void) => {
          body({
            draw: (effect: { label: string }) => {
              if (options.failComposite) throw new Error('composite failed');
              recorded.draws.push(effect.label);
            },
          });
        },
      });
    },
    settled: async () => {
      recorded.settled++;
    },
  } as unknown as Gpu;

  return { gpu, recorded };
}

const target = { size: [1280, 720] as const } as unknown as Target;

describe('deterministic thumbnail', () => {
  it('replays the golden sequence through the production shaders and composites once', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);

    const wrist = recorded.dispatches.filter((entry) => entry.label.endsWith('-wrist'));
    const paint = recorded.dispatches.filter((entry) => entry.label.endsWith('-paint'));
    expect(wrist).toHaveLength(SYNTHETIC_FRAME_COUNT);
    expect(paint).toHaveLength(SYNTHETIC_FRAME_COUNT);
    // One workgroup of BRUSH_COUNT invocations for the state machines, full mask
    // coverage for the capsules.
    expect(wrist.every((entry) => entry.workgroups === 1)).toBe(true);
    expect(paint.every((entry) => entry.workgroups === Math.ceil(MASK_TEXELS / 64))).toBe(true);
    expect(recorded.draws).toEqual(['air-painting-thumb-composite']);
  });

  it('uses the frozen transform and tuning in the wrist uniforms', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);

    const first = recorded.dispatches.find((entry) => entry.label.endsWith('-wrist'))!;
    expect(first.uniforms.source).toEqual([FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT]);
    // 640x360 letterboxed into 192x192: scale 0.3, 42 px of vertical padding.
    expect(first.uniforms.scale).toBeCloseTo(0.3, 10);
    expect(first.uniforms.pad).toEqual([0, 42]);
    expect(first.uniforms.dt).toBe(THUMB_DT);
    expect(first.uniforms.enter_confidence).toBe(BRUSH_TUNING.enterConfidence);
    expect(first.uniforms.stay_confidence).toBe(BRUSH_TUNING.stayConfidence);
    expect(first.uniforms.ema_tau).toBe(BRUSH_TUNING.emaTauSeconds);
    expect(first.uniforms.max_jump).toBeCloseTo(maxJumpDistance(), 12);
    // Both hands paint, and both paint at the extrapolated hand, not the wrist.
    expect(first.uniforms.hand_extend).toBe(HAND_EXTRAPOLATION.factor);
    expect(first.uniforms.elbow_confidence).toBe(HAND_EXTRAPOLATION.elbowConfidence);
    // The thumbnail never resets continuity mid-sequence.
    expect(
      recorded.dispatches
        .filter((entry) => entry.label.endsWith('-wrist'))
        .every((entry) => entry.uniforms.reset === 0),
    ).toBe(true);
  });

  it('uploads exactly one canned frame of the expected size', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    expect(recorded.textureWrites).toEqual([
      {
        bytes: FIXTURE_FRAME_WIDTH * FIXTURE_FRAME_HEIGHT * 4,
        width: FIXTURE_FRAME_WIDTH,
        height: FIXTURE_FRAME_HEIGHT,
      },
    ]);
  });

  it('allocates the frozen resource sizes', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const sizes = new Map(recorded.buffers.map((entry) => [entry.label, entry.size]));
    expect(sizes.get('air-painting-thumb-mask')).toBe(MASK_BYTES);
    expect(sizes.get('air-painting-thumb-brushes')).toBe(BRUSH_BUFFER_BYTES);
    expect(sizes.get('air-painting-thumb-keypoints')).toBe(KEYPOINT_BUFFER_BYTES);
    expect(recorded.textures[0]?.size).toEqual([FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT]);
  });

  it('passes the mask and dither contract to the compositor', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const uniforms = recorded.compositeUniforms.at(-1)!;
    expect(uniforms.resolution).toEqual([1280, 720]);
    expect(uniforms.mask_size).toEqual([MASK_WIDTH, MASK_HEIGHT]);
    expect(uniforms.source_size).toEqual([FIXTURE_FRAME_WIDTH, FIXTURE_FRAME_HEIGHT]);
    expect(uniforms.has_frame).toBe(1);
    // Fixed logical cell at dpr 1.
    expect(uniforms.cell).toBe(DITHER_CELL_LOGICAL_PX);
  });

  it('drains, settles and releases every owned resource', async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    expect(recorded.submitted).toBe(1);
    expect(recorded.settled).toBe(1);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
  });

  it('still drains and releases when compositing throws', async () => {
    const { gpu, recorded } = createFakeGpu({ failComposite: true });
    await expect(renderThumbnail(gpu, target)).rejects.toThrow('composite failed');
    expect(recorded.submitted).toBe(1);
    expect(recorded.settled).toBe(1);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
  });

  it('is deterministic: two runs record identical uniforms', async () => {
    const first = createFakeGpu();
    await renderThumbnail(first.gpu, target);
    const second = createFakeGpu();
    await renderThumbnail(second.gpu, target);
    expect(JSON.stringify(second.recorded.dispatches)).toBe(
      JSON.stringify(first.recorded.dispatches),
    );
  });
});

describe('Node thumbnail boundary', () => {
  const sources = ['renderer.ts', 'visual-pipeline.ts', 'fixtures.ts', 'pose-contract.ts'];

  it('never mentions ONNX Runtime in any module the Node bundle reaches', () => {
    for (const name of sources) {
      const source = readFileSync(join(here, name), 'utf8');
      expect(source, name).not.toMatch(/from ['"]onnxruntime/);
      expect(source, name).not.toMatch(/import\(['"]onnxruntime/);
      expect(source, name).not.toMatch(/ort-webgpu/);
    }
  });

  it('never reaches for a webcam or the network from those modules', () => {
    for (const name of sources) {
      const source = readFileSync(join(here, name), 'utf8');
      expect(source, name).not.toMatch(/getUserMedia|\bfetch\(/);
    }
  });
});
