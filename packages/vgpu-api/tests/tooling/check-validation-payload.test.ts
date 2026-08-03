import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, expect, test, vi } from "vitest";
import { runCheck } from "../../../vgpu/lib/check/run.js";

/**
 * `check`'s JSON contract must not depend on whether the machine running it has a WebGPU device:
 * a validation failure reports itself inside `validation` and still prints diagnostics, reflection
 * and wgsl. These cases drive that through a mocked runtime so they hold with or without a device
 * (the device-backed counterpart lives in check-cli.test.ts's reserved-word case).
 */
const state = vi.hoisted(() => ({ modes: [] as (string | undefined)[], thrown: undefined as unknown }));

vi.mock("@vgpu/wgsl/runtime", () => ({
  resolveShader: vi.fn(async (opts: { validate?: string }) => {
    state.modes.push(opts.validate);
    if (opts.validate === "off") return resolvedShader();
    throw state.thrown;
  }),
}));

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "../fixtures/sample.wgsl");

function resolvedShader() {
  return {
    deps: [entry],
    diagnostics: [],
    validation: { mode: "off", attempted: false, ok: true },
    reflection: { bindings: [], entryPoints: [{ name: "main", stage: "compute" }] },
    wgsl: "@compute @workgroup_size(1) fn main(){}\n",
  };
}

function nagaFailure() {
  return Object.assign(new Error("cannot convert value of type 'abstract-float' to type 'u32'"), {
    code: "VGPU-WGSL-NAGA-UNKNOWN",
    severity: "error",
    line: 1,
    column: 53,
    range: { file: "sample.wgsl", start: { line: 1, column: 53 } },
  });
}

function deviceFailure() {
  return Object.assign(new Error("device acquisition failed via @vgpu/adapter-node (VGPU-NODE-NO-ADAPTER): No WebGPU adapter available."), {
    code: "VGPU-WGSL-VALIDATE-NO-DEVICE",
    severity: "error",
    fix: "Install the portable CPU renderer with `npx vgpu install-software-renderer`, then retry.",
    where: "resolveShader",
    metadata: { causeCode: "VGPU-NODE-NO-ADAPTER" },
  });
}

beforeEach(() => {
  state.modes = [];
  state.thrown = undefined;
  delete process.env.VGPU_VALIDATE;
});

test("an invalid shader still prints the whole payload, with the failure inside validation", async () => {
  state.thrown = nagaFailure();
  const result = await runCheck([entry]);

  expect(result.code).toBe(1);
  expect(result.stderr).toBeUndefined();
  const output = JSON.parse(result.stdout ?? "{}");
  expect(output.schemaVersion).toBe(1);
  expect(output.reflection.entryPoints).toEqual([{ name: "main", stage: "compute" }]);
  expect(output.wgsl).toContain("fn main()");
  expect(output.validation).toEqual({
    mode: "auto",
    attempted: true,
    ok: false,
    error: {
      code: "VGPU-WGSL-NAGA-UNKNOWN",
      message: "cannot convert value of type 'abstract-float' to type 'u32'",
      severity: "error",
      line: 1,
      column: 53,
      range: { file: "sample.wgsl", start: { line: 1, column: 53 } },
    },
  });
  // The payload comes from a re-resolve with validation off; the first attempt used the default.
  expect(state.modes).toEqual([undefined, "off"]);
});

test("--require-validation forwards the device failure's fix and still exits 1 with a payload", async () => {
  state.thrown = deviceFailure();
  const result = await runCheck([entry, "--require-validation"]);

  expect(result.code).toBe(1);
  const output = JSON.parse(result.stdout ?? "{}");
  expect(output.validation.mode).toBe("require");
  expect(output.validation.ok).toBe(false);
  expect(output.validation.error).toMatchObject({
    code: "VGPU-WGSL-VALIDATE-NO-DEVICE",
    fix: "Install the portable CPU renderer with `npx vgpu install-software-renderer`, then retry.",
    where: "resolveShader",
    metadata: { causeCode: "VGPU-NODE-NO-ADAPTER" },
  });
  expect(output.reflection).toBeDefined();
  expect(state.modes).toEqual(["require", "off"]);
});

test("reports VGPU_VALIDATE as the mode when no flag was passed", async () => {
  process.env.VGPU_VALIDATE = "require";
  state.thrown = deviceFailure();
  const result = await runCheck([entry]);

  expect(JSON.parse(result.stdout ?? "{}").validation.mode).toBe("require");
});

test("a non-validation failure stays a hard error with no payload", async () => {
  state.thrown = Object.assign(new Error("Modules cannot declare bindings"), { code: "VGPU-RESOLVE-MODULE-BINDING", severity: "error" });
  const result = await runCheck([entry]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBeUndefined();
  expect(result.stderr).toContain("VGPU-RESOLVE-MODULE-BINDING");
  // No re-resolve: hiding a resolution failure behind validate: "off" would be wrong.
  expect(state.modes).toEqual([undefined]);
});

test("an invalid VGPU_VALIDATE is not swallowed by the retry", async () => {
  state.thrown = Object.assign(new Error('Invalid VGPU_VALIDATE="yes"; expected "off", "auto", or "require".'), {
    code: "VGPU-WGSL-VALIDATE-ENV-INVALID",
    severity: "error",
    fix: "Unset VGPU_VALIDATE or set it to off, auto, or require.",
  });
  const result = await runCheck([entry]);

  expect(result.code).toBe(1);
  expect(result.stdout).toBeUndefined();
  expect(result.stderr).toContain("VGPU-WGSL-VALIDATE-ENV-INVALID");
  expect(result.stderr).toContain("Unset VGPU_VALIDATE");
});
