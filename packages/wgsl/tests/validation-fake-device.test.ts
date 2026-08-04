import { beforeEach, expect, test, vi } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";
import { acquireValidationDevice } from "../src/runtime/validation-device.ts";

vi.mock("../src/runtime/validation-device.ts", () => ({ acquireValidationDevice: vi.fn(), retainValidationDevice: vi.fn(), releaseValidationDevice: vi.fn(), __resetValidationDeviceForTests: vi.fn() }));

type FakeMessage = { readonly type?: string; readonly message?: string; readonly lineNum?: number; readonly linePos?: number };

/**
 * Exercises validation.ts's diagnostic mapping without a GPU: the fake device receives the emitted
 * WGSL and reports a compilation message the test computes from that text, so the assertions stay
 * stable if emission (module order, DCE, mangled names) changes.
 */
function fakeDevice(pick: (code: string) => FakeMessage | undefined): GPUDevice {
  return {
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
    createShaderModule: ({ code }: { code: string }) => {
      const message = pick(code);
      return { getCompilationInfo: async () => ({ messages: message ? [{ type: "error", ...message }] : [] }) };
    },
  } as unknown as GPUDevice;
}

function lineOf(code: string, needle: string): number {
  const index = code.split(/\r?\n/).findIndex((line) => line.includes(needle));
  expect(index, `expected emitted WGSL to contain ${needle}`).toBeGreaterThanOrEqual(0);
  return index + 1;
}

const twoModules = { "/m.wgsl": "import { f } from './f.wgsl';\n@compute @workgroup_size(1) fn main(){ let x: u32 = f(); }", "/f.wgsl": "export fn f() -> f32 { return 1.0; }" };

beforeEach(() => {
  vi.mocked(acquireValidationDevice).mockReset();
});

test("maps an emitted line back to its source module and module-relative line", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(fakeDevice((code) => ({ message: "expected f32", lineNum: lineOf(code, "return 1.0"), linePos: 3 })));
  await expect(resolveShader({ entry: "/m.wgsl", validate: "auto", modules: twoModules })).rejects.toMatchObject({
    code: "VGPU-WGSL-NAGA-UNKNOWN",
    message: "expected f32",
    range: { file: "f.wgsl", start: { line: 1, column: 3 } },
  });
});

test("falls back to parsing the message when the device reports no line number", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(fakeDevice((code) => ({ message: `/tmp/shader.wgsl:${lineOf(code, "fn main")}:40 error: type mismatch` })));
  await expect(resolveShader({ entry: "/m.wgsl", validate: "auto", modules: twoModules })).rejects.toMatchObject({
    code: "VGPU-WGSL-NAGA-UNKNOWN",
    range: { file: "m.wgsl", start: { line: 1, column: 40 } },
  });
});

test("tags an approximate column when the line contains substituted identifiers", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(
    fakeDevice((code) => {
      const line = lineOf(code, "_vgsl_");
      const text = code.split(/\r?\n/)[line - 1] ?? "";
      // 1-based column pointing past the substituted identifier, which is what makes it approximate.
      return { message: "type mismatch", lineNum: line, linePos: text.indexOf("_vgsl_") + "_vgsl_".length + 2 };
    }),
  );
  await expect(resolveShader({ entry: "/m.wgsl", validate: "auto", modules: twoModules })).rejects.toMatchObject({
    code: "VGPU-WGSL-NAGA-UNKNOWN",
    columnPrecise: false,
    relatedDiagnostics: [expect.objectContaining({ code: "VGPU-WGSL-COL-APPROX" })],
    metadata: { codes: ["VGPU-WGSL-COL-APPROX"] },
  });
});

test("keeps the column precise when no identifier was substituted on the line", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(fakeDevice((code) => ({ message: "type mismatch", lineNum: lineOf(code, "fn main"), linePos: 12 })));
  try {
    await resolveShader({ entry: "/single.wgsl", validate: "auto", modules: { "/single.wgsl": "@compute @workgroup_size(1) fn main(){ let x: u32 = 1.0; }" } });
    throw new Error("expected validation failure");
  } catch (error) {
    expect(error).toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN", range: { file: "single.wgsl" }, columnPrecise: true });
    expect(JSON.stringify(error)).not.toContain("VGPU-WGSL-COL-APPROX");
  }
});

test("reports a successful attempt when the device finds no errors", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(fakeDevice(() => undefined));
  const result = await resolveShader({ entry: "/m.wgsl", validate: "auto", modules: twoModules });
  expect(result.validation).toEqual({ mode: "auto", attempted: true, ok: true });
});

test("validates once more after safe identifier minification", async () => {
  vi.mocked(acquireValidationDevice).mockResolvedValue(fakeDevice(() => undefined));
  const result = await resolveShader({ entry: "/m.wgsl", validate: "auto", minify: true, modules: twoModules });
  expect(result.validation).toEqual({ mode: "auto", attempted: true, ok: true });
  expect(vi.mocked(acquireValidationDevice)).toHaveBeenCalledTimes(2);
});

/** Records every WGSL string the device was asked to compile, in order. */
function recordingDevice(seen: string[], pick: (code: string) => FakeMessage | undefined = () => undefined): GPUDevice {
  return fakeDevice((code) => {
    seen.push(code);
    return pick(code);
  });
}

test("whitespace-only minification validates the final returned wgsl, not only the emitted text", async () => {
  const seen: string[] = [];
  vi.mocked(acquireValidationDevice).mockResolvedValue(recordingDevice(seen));
  const result = await resolveShader({ entry: "/m.wgsl", validate: "auto", minify: { whitespace: true }, modules: twoModules });

  // The contract this pins: whatever the minify mode, the last string handed to the device is the
  // string the caller receives. Whitespace-only used to skip this pass entirely, so a
  // whitespace-stage corruption shipped with `validation.ok === true`.
  expect(seen).toHaveLength(2);
  expect(seen.at(-1)).toBe(result.wgsl);
  // The pre-minify pass still runs first: it is the one with usable line/column mapping.
  expect(seen[0]).not.toBe(result.wgsl);
  expect(seen[0]).toContain("\n");
  expect(result.validation).toEqual({ mode: "auto", attempted: true, ok: true });
});

test("whitespace-only minification fails loudly when only the minified text is invalid", async () => {
  // The fake device accepts the multi-line emitted text and rejects the single-line minified text,
  // standing in for any whitespace-stage corruption (e.g. a split `.5` literal) without depending on
  // a particular minifier bug.
  const seen: string[] = [];
  vi.mocked(acquireValidationDevice).mockResolvedValue(recordingDevice(seen, (code) => (code.includes("\n") ? undefined : { message: "unable to parse right side of assignment", lineNum: 1, linePos: 1 })));

  await expect(resolveShader({ entry: "/m.wgsl", validate: "require", minify: { whitespace: true }, modules: twoModules })).rejects.toMatchObject({ code: "VGPU-WGSL-NAGA-UNKNOWN" });
  expect(seen).toHaveLength(2);
});

test("validates once when minification is a no-op, since the returned text is the validated text", async () => {
  const seen: string[] = [];
  vi.mocked(acquireValidationDevice).mockResolvedValue(recordingDevice(seen));
  const result = await resolveShader({ entry: "/m.wgsl", validate: "auto", minify: { whitespace: false, identifiers: "none" }, modules: twoModules });

  expect(seen).toEqual([result.wgsl]);
  expect(result.validation).toEqual({ mode: "auto", attempted: true, ok: true });
});
