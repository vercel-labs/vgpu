import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Gpu, Target } from "vgpu";
import {
  FIXTURE_FRAME_HEIGHT,
  FIXTURE_FRAME_WIDTH,
  SYNTHETIC_FRAME_COUNT,
  syntheticHandFrames,
} from "./fixtures";
import {
  BRUSH_BUFFER_BYTES,
  MASK_BYTES,
  MASK_HEIGHT,
  MASK_TEXELS,
  MASK_WIDTH,
  ROI_BYTES,
  ROI_DETECTOR_SLOT,
  createVisualPipeline,
} from "./visual-pipeline";
import {
  DETECTOR_INPUT_BYTES,
  DETECTOR_SIZE,
  LANDMARK_INPUT_BYTES,
  LANDMARK_POINTS_BUFFER_BYTES,
  LANDMARK_SIZE,
} from "./hand-model-contract";
import { renderThumbnail, THUMB_DT } from "./render-thumbnail";

// 0.2.0 replaced the `Gpu` facade with free functions, and a real one resolves a kernel this
// file's fake gpu does not have ("no vgpu kernel"). The double now stands in for the free
// functions instead, delegating to the recorder methods the fake already exposes — so the
// assertions below still observe every dispatch, uniform and release without a device.
vi.mock("vgpu", () => {
  type FakeGpu = Record<string, (...args: never[]) => unknown>;
  const delegate =
    (name: string) =>
    (gpu: FakeGpu, ...args: never[]) =>
      gpu[name]!(...args);
  return {
    compute: delegate("compute"),
    effect: delegate("effect"),
    frame: delegate("frame"),
    sampler: delegate("sampler"),
    surface: delegate("surface"),
    target: delegate("target"),
  };
});

const here = dirname(fileURLToPath(import.meta.url));

interface Dispatch {
  label: string;
  workgroups: readonly number[];
  uniforms: Record<string, unknown>;
  bindings: Record<string, unknown>;
}

interface Recorded {
  readonly dispatches: Dispatch[];
  readonly draws: string[];
  readonly buffers: { label: string; size: number; destroyed: boolean }[];
  readonly textures: {
    label: string;
    size: readonly number[];
    destroyed: boolean;
  }[];
  readonly targets: {
    label: string;
    size: readonly number[];
    destroyed: boolean;
  }[];
  readonly writes: { label: string; bytes: number; offset: number }[];
  readonly textureWrites: { bytes: number; width: number; height: number }[];
  readonly compositeUniforms: Record<string, unknown>[];
  settled: number;
  submitted: number;
}

interface FakeGpuOptions {
  readonly failComposite?: unknown;
  readonly failBuffer?: { readonly at: number; readonly error: unknown };
  readonly failTarget?: { readonly at: number; readonly error: unknown };
  readonly rejectSubmitted?: unknown;
  readonly rejectSettled?: unknown;
  readonly failDisposeLabel?: string;
  readonly disposeError?: unknown;
}

function createFakeGpu(options: FakeGpuOptions = {}) {
  const recorded: Recorded = {
    dispatches: [],
    draws: [],
    buffers: [],
    textures: [],
    targets: [],
    writes: [],
    textureWrites: [],
    compositeUniforms: [],
    settled: 0,
    submitted: 0,
  };

  let bufferCreations = 0;
  let targetCreations = 0;
  const makeBuffer = (opts: { size: number; label?: string }) => {
    bufferCreations++;
    if (options.failBuffer?.at === bufferCreations)
      throw options.failBuffer.error;
    const entry = {
      label: opts.label ?? "",
      size: opts.size,
      destroyed: false,
    };
    recorded.buffers.push(entry);
    return {
      gpu: { size: opts.size, marker: entry.label },
      size: opts.size,
      write(data: Uint8Array, offset = 0) {
        recorded.writes.push({
          label: entry.label,
          bytes: data.byteLength,
          offset,
        });
      },
      dispose() {
        entry.destroyed = true;
        if (entry.label === options.failDisposeLabel)
          throw options.disposeError;
      },
    };
  };

  const makeCompute = (label: string) => {
    let uniforms: Record<string, unknown> = {};
    let bindings: Record<string, unknown> = {};
    return {
      set(values: Record<string, unknown>) {
        // `hand`/`paint` name their block `uniforms`; `hand-crop` names it `crop`.
        uniforms =
          ((values.uniforms ?? values.crop) as Record<string, unknown>) ?? {};
        bindings = values;
        return this;
      },
      dispatch(x: number, y = 1, z = 1) {
        recorded.dispatches.push({
          label,
          workgroups: [x, y, z],
          uniforms,
          bindings,
        });
      },
    };
  };

  const gpu = {
    device: {
      createBuffer: (opts: { size: number; label?: string }) =>
        makeBuffer(opts),
      createTexture: (opts: { size: readonly number[]; label?: string }) => {
        const entry = {
          label: opts.label ?? "",
          size: opts.size,
          destroyed: false,
        };
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
          size: { width: number; height: number }
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
          if (options.rejectSubmitted) throw options.rejectSubmitted;
        },
      },
    },
    sampler: () => ({ marker: "sampler" }),
    compute: (_source: string, opts: { label?: string }) =>
      makeCompute(opts.label ?? "compute"),
    effect: (_source: string, opts: { label?: string }) => ({
      label: opts.label ?? "effect",
      set(values: Record<string, unknown>) {
        // Only the compositor sets a `uniforms` block; frost sets `frost`.
        if (values.uniforms) {
          recorded.compositeUniforms.push(
            values.uniforms as Record<string, unknown>
          );
        }
        return this;
      },
    }),
    target: (opts: { size: readonly number[]; label?: string }) => {
      targetCreations++;
      if (options.failTarget?.at === targetCreations)
        throw options.failTarget.error;
      const entry = {
        label: opts.label ?? "",
        size: opts.size,
        destroyed: false,
      };
      recorded.targets.push(entry);
      return {
        size: opts.size,
        texelSize: [1 / opts.size[0]!, 1 / opts.size[1]!] as const,
        color: { createView: () => ({}), gpu: { marker: entry.label } },
        destroy() {
          entry.destroyed = true;
        },
      };
    },
    frame: (cb: (frame: unknown) => void) => {
      cb({
        pass: (_opts: unknown, body: (pass: unknown) => void) => {
          body({
            draw: (effect: { label: string }) => {
              if (options.failComposite) throw options.failComposite;
              recorded.draws.push(effect.label);
            },
          });
        },
      });
    },
    settled: async () => {
      recorded.settled++;
      if (options.rejectSettled) throw options.rejectSettled;
    },
  } as unknown as Gpu;

  return { gpu, recorded };
}

const target = { size: [1280, 720] as const } as unknown as Target;

describe("deterministic thumbnail", () => {
  it("replays the golden sequence through the production shaders and composites once", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);

    const hand = recorded.dispatches.filter((entry) =>
      entry.label.endsWith("-hand")
    );
    const paint = recorded.dispatches.filter((entry) =>
      entry.label.endsWith("-paint")
    );
    expect(hand).toHaveLength(SYNTHETIC_FRAME_COUNT);
    expect(paint).toHaveLength(SYNTHETIC_FRAME_COUNT);
    // One workgroup of BRUSH_COUNT invocations for the state machines, full mask
    // coverage for the capsules.
    expect(hand.every((entry) => entry.workgroups[0] === 1)).toBe(true);
    expect(
      paint.every(
        (entry) => entry.workgroups[0] === Math.ceil(MASK_TEXELS / 64)
      )
    ).toBe(true);
    // Frost is separable: horizontal, then vertical, then the composite that
    // samples the result. All three land in one frame, in that order.
    expect(recorded.draws).toEqual([
      "air-painting-thumb-frost-h",
      "air-painting-thumb-frost-v",
      "air-painting-thumb-composite",
    ]);
  });

  it("uses the frozen source size and tuning in the hand uniforms", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);

    const first = recorded.dispatches.find((entry) =>
      entry.label.endsWith("-hand")
    )!;
    expect(first.uniforms.source).toEqual([
      FIXTURE_FRAME_WIDTH,
      FIXTURE_FRAME_HEIGHT,
    ]);
    expect(first.uniforms.dt).toBe(THUMB_DT);
    // Both hands run every frame of the golden sequence.
    expect(first.uniforms.ran).toEqual([1, 1]);
    expect((first.uniforms.presence as number[])[0]).toBeGreaterThan(0.45);
    // The thumbnail never resets continuity mid-sequence.
    expect(
      recorded.dispatches
        .filter((entry) => entry.label.endsWith("-hand"))
        .every((entry) => entry.uniforms.reset === 0)
    ).toBe(true);
  });

  it("binds a distinct landmark buffer per slot, never the idle stand-in", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const first = recorded.dispatches.find((entry) =>
      entry.label.endsWith("-hand")
    )!;
    const lm0 = first.bindings.lm0 as { gpu: { marker: string } };
    const lm1 = first.bindings.lm1 as { gpu: { marker: string } };
    expect(lm0.gpu.marker).toBe("air-painting-thumb-landmarks-0");
    expect(lm1.gpu.marker).toBe("air-painting-thumb-landmarks-1");
  });

  it("writes both hands ROIs before every dispatch that reads them", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const roiWrites = recorded.writes.filter((entry) =>
      entry.label.endsWith("-rois")
    );
    // One per slot per frame, plus the detector letterbox written at creation.
    expect(roiWrites).toHaveLength(SYNTHETIC_FRAME_COUNT * 2 + 1);
    // The detector's entry is written once, at its own offset.
    expect(roiWrites[0]!.offset).toBe(ROI_DETECTOR_SLOT * 16);
    expect(roiWrites.slice(1).map((entry) => entry.offset)).toEqual(
      Array.from(
        { length: SYNTHETIC_FRAME_COUNT * 2 },
        (_unused, i) => (i % 2) * 16
      )
    );
  });

  it("uploads exactly one canned frame of the expected size", async () => {
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

  it("allocates the frozen resource sizes", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const sizes = new Map(
      recorded.buffers.map((entry) => [entry.label, entry.size])
    );
    expect(sizes.get("air-painting-thumb-mask")).toBe(MASK_BYTES);
    expect(sizes.get("air-painting-thumb-brushes")).toBe(BRUSH_BUFFER_BYTES);
    expect(sizes.get("air-painting-thumb-rois")).toBe(ROI_BYTES);
    expect(sizes.get("air-painting-thumb-landmarks-0")).toBe(
      LANDMARK_POINTS_BUFFER_BYTES
    );
    // The model input buffers are exactly the tensors the graphs declare.
    expect(sizes.get("air-painting-thumb-detector-input")).toBe(
      DETECTOR_INPUT_BYTES
    );
    expect(sizes.get("air-painting-thumb-landmark-input-0")).toBe(
      LANDMARK_INPUT_BYTES
    );
    expect(sizes.get("air-painting-thumb-landmark-input-1")).toBe(
      LANDMARK_INPUT_BYTES
    );
    expect(recorded.textures[0]?.size).toEqual([
      FIXTURE_FRAME_WIDTH,
      FIXTURE_FRAME_HEIGHT,
    ]);
  });

  it("passes the mask and frost contract to the compositor", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const uniforms = recorded.compositeUniforms.at(-1)!;
    expect(uniforms.resolution).toEqual([1280, 720]);
    expect(uniforms.mask_size).toEqual([MASK_WIDTH, MASK_HEIGHT]);
    expect(uniforms.source_size).toEqual([
      FIXTURE_FRAME_WIDTH,
      FIXTURE_FRAME_HEIGHT,
    ]);
    expect(uniforms.has_frame).toBe(1);
    expect(uniforms.grain_cell).toBe(4);
  });

  it("sizes the frost chain to the downsampled camera frame", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const expected = [
      Math.ceil(FIXTURE_FRAME_WIDTH / 4),
      Math.ceil(FIXTURE_FRAME_HEIGHT / 4),
    ];
    expect(recorded.targets).toHaveLength(2);
    for (const entry of recorded.targets) expect(entry.size).toEqual(expected);
  });

  it("drives the re-fog from the same dt the state machine uses", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    const paint = recorded.dispatches.filter((entry) =>
      entry.label.endsWith("-paint")
    );
    const decay = Math.exp(-THUMB_DT / 7);
    // Every step fogs by exactly one dt, and none of them fully clears.
    expect(paint.every((entry) => entry.uniforms.decay === decay)).toBe(true);
    expect(decay).toBeGreaterThan(0);
    expect(decay).toBeLessThan(1);
    expect(paint[0]!.uniforms).toMatchObject({
      mask_size: [MASK_WIDTH, MASK_HEIGHT],
      radius: 30,
      feather: 4,
      clear_epsilon: 1 / 255,
    });
  });

  it("drains, settles and releases every owned resource", async () => {
    const { gpu, recorded } = createFakeGpu();
    await renderThumbnail(gpu, target);
    expect(recorded.submitted).toBe(1);
    expect(recorded.settled).toBe(1);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });

  it("still drains and releases when compositing throws", async () => {
    const failure = new Error("composite failed");
    const { gpu, recorded } = createFakeGpu({ failComposite: failure });
    await expect(renderThumbnail(gpu, target)).rejects.toBe(failure);
    expect(recorded.submitted).toBe(1);
    expect(recorded.settled).toBe(1);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });

  it("preserves the render error while both cleanup barriers reject", async () => {
    const failure = new Error("render failed");
    const { gpu, recorded } = createFakeGpu({
      failComposite: failure,
      rejectSubmitted: new Error("queue failed"),
      rejectSettled: new Error("settled failed"),
    });
    await expect(renderThumbnail(gpu, target)).rejects.toBe(failure);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });

  it("cleans the pipeline and first landmark when the second allocation fails", async () => {
    const failure = new Error("landmark allocation failed");
    const { gpu, recorded } = createFakeGpu({
      failBuffer: { at: 9, error: failure },
    });
    await expect(renderThumbnail(gpu, target)).rejects.toBe(failure);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });

  it("is deterministic: two runs record identical uniforms", async () => {
    const first = createFakeGpu();
    await renderThumbnail(first.gpu, target);
    const second = createFakeGpu();
    await renderThumbnail(second.gpu, target);
    expect(
      JSON.stringify(second.recorded.dispatches.map((d) => d.uniforms))
    ).toBe(JSON.stringify(first.recorded.dispatches.map((d) => d.uniforms)));
  });
});

describe("GPU crop dispatch", () => {
  function pipelineFor() {
    const { gpu, recorded } = createFakeGpu();
    const pipeline = createVisualPipeline(gpu, {
      sourceWidth: 640,
      sourceHeight: 360,
      label: "crop-test",
    });
    return { pipeline, recorded };
  }

  it("crops the detector input at 192 from the letterbox ROI slot", () => {
    const { pipeline, recorded } = pipelineFor();
    pipeline.cropDetectorInput();
    const dispatch = recorded.dispatches.at(-1)!;
    expect(dispatch.label).toBe("crop-test-crop");
    expect(dispatch.uniforms.out_size).toBe(DETECTOR_SIZE);
    expect(dispatch.uniforms.roi_index).toBe(ROI_DETECTOR_SLOT);
    expect(dispatch.uniforms.source).toEqual([640, 360]);
    // 192 / 8 = 24 workgroups per axis.
    expect(dispatch.workgroups.slice(0, 2)).toEqual([24, 24]);
    pipeline.dispose();
  });

  it("crops each hand at 224 from its own ROI slot", () => {
    const { pipeline, recorded } = pipelineFor();
    pipeline.cropLandmarkInput(1);
    const dispatch = recorded.dispatches.at(-1)!;
    expect(dispatch.uniforms.out_size).toBe(LANDMARK_SIZE);
    expect(dispatch.uniforms.roi_index).toBe(1);
    // 224 / 8 = 28 workgroups per axis.
    expect(dispatch.workgroups.slice(0, 2)).toEqual([28, 28]);
    const out = dispatch.bindings.out_buf as { gpu: { marker: string } };
    expect(out.gpu.marker).toBe("crop-test-landmark-input-1");
    pipeline.dispose();
  });

  it("writes the detector letterbox once at creation and again on resize", () => {
    const { pipeline, recorded } = pipelineFor();
    const before = recorded.writes.filter((e) =>
      e.label.endsWith("-rois")
    ).length;
    expect(before).toBe(1);
    pipeline.resizeSource(1280, 720);
    const after = recorded.writes.filter((e) => e.label.endsWith("-rois"));
    expect(after).toHaveLength(2);
    expect(after[1]!.offset).toBe(ROI_DETECTOR_SLOT * 16);
    pipeline.dispose();
  });

  it("rejects an out-of-range ROI slot rather than corrupting a neighbour", () => {
    const { pipeline } = pipelineFor();
    expect(() =>
      pipeline.writeRoi(3, { cx: 0, cy: 0, size: 1, rotation: 0 })
    ).toThrow();
    expect(() =>
      pipeline.writeRoi(-1, { cx: 0, cy: 0, size: 1, rotation: 0 })
    ).toThrow();
    pipeline.dispose();
  });

  it("marks a slot that did not run so the shader ignores its stale buffer", () => {
    const { pipeline, recorded } = pipelineFor();
    const frame = syntheticHandFrames(640, 360, 1)[0]!;
    const buffer = recorded.buffers.find((b) =>
      b.label.endsWith("-landmarks-idle")
    );
    expect(buffer).toBeDefined();
    // Only slot 0 produced a result this frame.
    pipeline.consumeHandLandmarks(
      [
        {
          landmarks: pipeline.detectorInput,
          presence: frame.results[0]!.presence,
        },
      ],
      1 / 30
    );
    const dispatch = recorded.dispatches.find((d) =>
      d.label.endsWith("-hand")
    )!;
    expect(dispatch.uniforms.ran).toEqual([1, 0]);
    expect((dispatch.uniforms.presence as number[])[1]).toBe(0);
    const lm1 = dispatch.bindings.lm1 as { gpu: { marker: string } };
    expect(lm1.gpu.marker).toBe("crop-test-landmarks-idle");
    pipeline.dispose();
  });

  it("releases partial resources without masking a construction failure", () => {
    const failure = new Error("target allocation failed");
    const { gpu, recorded } = createFakeGpu({
      failTarget: { at: 2, error: failure },
    });
    expect(() =>
      createVisualPipeline(gpu, { sourceWidth: 640, sourceHeight: 360 })
    ).toThrow(failure);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });

  it("continues disposing after one child throws", () => {
    const failure = new Error("dispose failed");
    const { gpu, recorded } = createFakeGpu({
      failDisposeLabel: "crop-test-rois",
      disposeError: failure,
    });
    const pipeline = createVisualPipeline(gpu, {
      sourceWidth: 640,
      sourceHeight: 360,
      label: "crop-test",
    });
    expect(() => pipeline.dispose()).toThrow(failure);
    expect(recorded.buffers.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.textures.every((entry) => entry.destroyed)).toBe(true);
    expect(recorded.targets.every((entry) => entry.destroyed)).toBe(true);
  });
});

describe("Node thumbnail boundary", () => {
  const sources = [
    "render-thumbnail.ts",
    "visual-pipeline.ts",
    "fixtures.ts",
    "hand-model-contract.ts",
    "hand-pipeline.ts",
  ];

  it("never mentions ONNX Runtime in any module the Node bundle reaches", () => {
    for (const name of sources) {
      const source = readFileSync(join(here, name), "utf8");
      expect(source, name).not.toMatch(/from ['"]onnxruntime/);
      expect(source, name).not.toMatch(/import\(['"]onnxruntime/);
      expect(source, name).not.toMatch(/ort-webgpu/);
    }
  });

  it("never reaches for a webcam or the network from those modules", () => {
    for (const name of sources) {
      const source = readFileSync(join(here, name), "utf8");
      expect(source, name).not.toMatch(/getUserMedia|\bfetch\(/);
    }
  });
});
