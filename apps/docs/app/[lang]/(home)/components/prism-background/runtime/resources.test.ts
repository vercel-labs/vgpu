import { beforeEach, describe, expect, test, vi } from "vitest";

const environment = vi.hoisted(() => ({
  create: vi.fn((_gpu: unknown, label: string) => ({ label })),
  prepare: vi.fn(),
}));

vi.mock("../environment/texture", () => ({
  createEnvironmentSampler: vi.fn(),
  createEnvironmentTexture: environment.create,
  destroyEnvironmentTexture: vi.fn(),
  prepareEnvironmentTexture: environment.prepare,
}));

import { prepareRuntimeEnvironment } from "./resources";
import type { PrismRuntime } from "./types";

describe("runtime environment lifecycle", () => {
  beforeEach(() => {
    environment.create.mockClear();
    environment.prepare.mockReset();
    environment.prepare.mockResolvedValue(undefined);
  });

  test("production creates and prepares only the studio environment", async () => {
    const runtime = runtimeStub(false);

    const ready = prepareRuntimeEnvironment(runtime);
    expect(prepareRuntimeEnvironment(runtime)).toBe(ready);
    await ready;

    expect(environment.create).toHaveBeenCalledTimes(1);
    expect(environment.create).toHaveBeenCalledWith(
      runtime.gpu,
      "lifecycle-test.environment-studio",
      false
    );
    expect(environment.prepare).toHaveBeenCalledTimes(1);
    expect(runtime.studioEnvironment).toBeDefined();
    expect(runtime.debugEnvironment).toBeUndefined();
  });

  test("debug mode creates both maps and waits for both before rejecting", async () => {
    const lateBake = deferred<void>();
    const firstFailure = new Error("studio bake failed");
    environment.prepare.mockImplementation(
      (_gpu: unknown, value: { label: string }) =>
        value.label.endsWith("environment-studio")
          ? Promise.reject(firstFailure)
          : lateBake.promise
    );
    const runtime = runtimeStub(true);

    const ready = prepareRuntimeEnvironment(runtime);
    let settled = false;
    void ready.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    const rejection = expect(ready).rejects.toBe(firstFailure);
    await settleMicrotasks();
    expect(settled).toBe(false);
    expect(environment.create.mock.calls.map((call) => call.slice(1))).toEqual([
      ["lifecycle-test.environment-studio", false],
      ["lifecycle-test.environment-debug", true],
    ]);

    lateBake.resolve();
    await rejection;
    expect(settled).toBe(true);
    expect(prepareRuntimeEnvironment(runtime)).toBe(ready);
  });
});

function runtimeStub(debugEnvironmentEnabled: boolean): PrismRuntime {
  return {
    gpu: {},
    label: "lifecycle-test",
    environmentSampler: {},
    debugEnvironmentEnabled,
  } as PrismRuntime;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
