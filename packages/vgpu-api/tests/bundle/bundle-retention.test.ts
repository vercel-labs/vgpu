import { prepareShader } from "@vgpu/wgsl/prepare";
import { expect, test, vi } from "vitest";
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, effect, frame, init, target } from "../../src/mock.ts";

const SOLID = `
@fragment fn main() -> @location(0) vec4f { return vec4f(1); }
`;

const SAMPLED = `
@group(0) @binding(0) var source: texture_2d<f32>;
@fragment fn main() -> @location(0) vec4f { return textureLoad(source, vec2i(0), 0); }
`;

const UNIFORM = `
struct Params { value: f32 }
@group(0) @binding(0) var<uniform> params: Params;
@fragment fn main() -> @location(0) vec4f { return vec4f(params.value); }
`;

test("Bundle.dispose() is idempotent and guards native access and replay", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SOLID));
    const recorded = bundle(gpu, { target: output, label: "retired" }, (recorder) => recorder.draw(drawable));

    recorded.dispose();
    expect(() => recorded.dispose()).not.toThrow();
    expect(recorded.id).toBe("retired");
    expect(() => recorded.gpu).toThrowError(expect.objectContaining({
      code: "VGPU-BUNDLE-DISPOSED",
      fix: "Record a new bundle before replaying; this bundle was disposed.",
    }));

    const submit = vi.spyOn(gpu.gpu.queue, "submit");
    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(output, (pass) => pass.bundles(recorded));
    })).toThrowError(expect.objectContaining({ code: "VGPU-BUNDLE-DISPOSED" }));
    expect(submit).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("the first permanent stale event detaches a bundle from every draw and resource", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const firstSource = target(gpu, { size: [4, 4] });
    const secondSource = target(gpu, { size: [4, 4] });
    const replacement = target(gpu, { size: [4, 4] });
    const first = effect(gpu, prepareShader(SAMPLED), { label: "first", set: { source: firstSource } });
    const second = effect(gpu, prepareShader(SAMPLED), { label: "second", set: { source: secondSource } });
    const recorded = bundle(gpu, { target: output, label: "stale-once" }, (recorder) => {
      recorder.draw(first);
      recorder.draw(second);
    });
    const markStale = vi.spyOn(recorded as unknown as { markStale(event: unknown): void }, "markStale");

    first.set({ source: replacement });
    second.set({ source: replacement });
    first.set({ source: firstSource });
    firstSource.destroy();
    secondSource.destroy();

    expect(markStale).toHaveBeenCalledTimes(1);
    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(output, (pass) => pass.bundles(recorded));
    })).toThrowError(expect.objectContaining({
      code: "VGPU-R3-BUNDLE-STALE",
      message: expect.stringContaining("binding `source`"),
    }));
    recorded.dispose();
    expect(() => recorded.gpu).toThrowError(expect.objectContaining({ code: "VGPU-BUNDLE-DISPOSED" }));
  } finally {
    gpu.dispose();
  }
});

test("failed recording releases every captured resource subscription", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const source = target(gpu, { size: [4, 4] });
    const replacement = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, prepareShader(SAMPLED), { set: { source: source.color } });
    const subscribe = source.color.onDestroy.bind(source.color);
    const offs: ReturnType<typeof vi.fn>[] = [];
    vi.spyOn(source.color, "onDestroy").mockImplementation((callback) => {
      const off = vi.fn(subscribe(callback));
      offs.push(off);
      return off;
    });

    expect(() => bundle(gpu, { target: output }, (recorder) => {
      recorder.draw(sampled);
      throw new Error("recording failed");
    })).toThrow("recording failed");
    expect(offs).toHaveLength(1);
    expect(offs[0]).toHaveBeenCalledTimes(1);

    sampled.set({ source: replacement.color });
    source.color.destroy();
    expect(offs[0]).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});

test("abandoned valid bundles are collectable through draw and resource reverse references", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vgpu-bundle-retention-"));
  const outfile = join(directory, "bundle-retention-gc.mjs");
  try {
    await build({
      entryPoints: [fileURLToPath(new URL("./bundle-retention-gc.ts", import.meta.url))],
      outfile,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
    });
    const probe = spawnSync(process.execPath, ["--expose-gc", outfile], { encoding: "utf8", timeout: 30_000 });
    expect(probe.status, `GC probe failed\nstdout:\n${probe.stdout}\nstderr:\n${probe.stderr}`).toBe(0);
    expect(JSON.parse(probe.stdout.trim())).toEqual({
      collected: 128,
      registryEntries: 1,
      retained: true,
      staleBundle: "retained-stale",
      lateDrawCollected: true,
      activeBundleSubscriptions: 0,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("disposing one facade preserves encoded work, saved native handles, shared resources, and other bundles", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const source = target(gpu, { size: [4, 4] });
    const sampled = effect(gpu, prepareShader(SAMPLED), { label: "shared", set: { source: source.color } });
    const retired = bundle(gpu, { target: output, label: "retired-shared" }, (recorder) => recorder.draw(sampled));
    const live = bundle(gpu, { target: output, label: "live-shared" }, (recorder) => recorder.draw(sampled));
    const savedNative = retired.gpu;
    const pending = frame(gpu);
    pending.pass(output, (pass) => pass.bundles(retired));
    const submit = vi.spyOn(gpu.gpu.queue, "submit");

    retired.dispose();
    expect(() => pending.submit()).not.toThrow();
    expect(submit).toHaveBeenCalledTimes(1);
    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(output, (pass) => pass.bundles(live));
    })).not.toThrow();

    const encoder = gpu.gpu.createCommandEncoder();
    const pass = encoder.beginRenderPass(output.renderPassDescriptor());
    pass.executeBundles([savedNative]);
    pass.end();
    expect(() => gpu.gpu.queue.submit([encoder.finish()])).not.toThrow();

    source.color.destroy();
    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(output, (framePass) => framePass.bundles(live));
    })).toThrowError(expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }));
  } finally {
    gpu.dispose();
  }
});

test("a mixed live and disposed bundle list encodes none of the list", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(SOLID));
    const live = bundle(gpu, { target: output, label: "live" }, (recorder) => recorder.draw(drawable));
    const disposed = bundle(gpu, { target: output, label: "disposed" }, (recorder) => recorder.draw(drawable));
    disposed.dispose();
    const executeBundles = vi.fn();
    const createCommandEncoder = gpu.gpu.createCommandEncoder.bind(gpu.gpu);
    vi.spyOn(gpu.gpu, "createCommandEncoder").mockImplementation((descriptor) => {
      const encoder = createCommandEncoder(descriptor);
      const beginRenderPass = encoder.beginRenderPass.bind(encoder);
      encoder.beginRenderPass = (passDescriptor) => {
        const pass = beginRenderPass(passDescriptor);
        const execute = pass.executeBundles.bind(pass);
        pass.executeBundles = (bundles) => { executeBundles(); execute(bundles); };
        return pass;
      };
      return encoder;
    });

    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(output, (pass) => pass.bundles(live, disposed));
    })).toThrowError(expect.objectContaining({ code: "VGPU-BUNDLE-DISPOSED" }));
    expect(executeBundles).not.toHaveBeenCalled();
  } finally {
    gpu.dispose();
  }
});

test("a wrong replay target does not poison a later compatible replay", async () => {
  const gpu = await init();
  try {
    const compatible = target(gpu, { size: [4, 4], format: "rgba8unorm" });
    const incompatible = target(gpu, { size: [4, 4], format: "bgra8unorm" });
    const drawable = effect(gpu, prepareShader(SOLID));
    const recorded = bundle(gpu, { target: compatible, label: "target-mismatch" }, (recorder) => recorder.draw(drawable));

    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(incompatible, (pass) => pass.bundles(recorded));
    })).toThrowError(expect.objectContaining({ code: "VGPU-R3-BUNDLE-STALE" }));
    expect(() => frame(gpu, (currentFrame) => {
      currentFrame.pass(compatible, (pass) => pass.bundles(recorded));
    })).not.toThrow();
  } finally {
    gpu.dispose();
  }
});

test("recording keeps managed uniforms eager for previously exposed native consumers", async () => {
  const gpu = await init();
  try {
    const output = target(gpu, { size: [4, 4] });
    const drawable = effect(gpu, prepareShader(UNIFORM), { set: { params: { value: 0.25 } } });
    const recorded = bundle(gpu, { target: output }, (recorder) => recorder.draw(drawable));
    const native = recorded.gpu;
    const writeBuffer = vi.spyOn(gpu.gpu.queue, "writeBuffer");

    recorded.dispose();
    drawable.set({ params: { value: 0.75 } });

    expect(native).toBeDefined();
    expect(writeBuffer).toHaveBeenCalledTimes(1);
  } finally {
    gpu.dispose();
  }
});
