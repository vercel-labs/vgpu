import {
  access,
  chmod,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { invokeTintWorker } from "../src/compiler/worker.ts";

test("request text that cannot be encoded losslessly as UTF-8 is rejected", async () => {
  await expect(
    invokeTintWorker({
      executable: "/does-not-exist/vgpu-worker",
      request: '"\ud800"',
    })
  ).rejects.toMatchObject({
    code: "invalid-request",
  });
});

test("the process deadline cannot be disabled, extended, or made invalid", async () => {
  for (const timeoutMs of [
    0,
    -1,
    0.5,
    60_001,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ]) {
    await expect(
      invokeTintWorker({
        executable: "/does-not-exist/vgpu-worker",
        request: "{}",
        timeoutMs,
      })
    ).rejects.toMatchObject({
      code: "invalid-timeout",
    });
  }
});

test("an oversized executable is refused without unbounded file loading", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "vgpu-worker-test-"));
  try {
    const executable = join(scratch, "worker");
    await writeFile(executable, "");
    await truncate(executable, 16 * 1024 * 1024 + 1);
    await expect(
      invokeTintWorker({ executable, request: "{}" })
    ).rejects.toMatchObject({
      code: "executable-unavailable",
      cause: expect.objectContaining({
        message: expect.stringContaining("16 MiB"),
      }),
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("a symbolic-link worker is rejected as an unsuitable executable file", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "vgpu-worker-test-"));
  try {
    const target = join(scratch, "target");
    const executable = join(scratch, "worker");
    await writeFile(target, "not a compiler");
    await symlink(target, executable);

    await expect(
      invokeTintWorker({ executable, request: "{}" })
    ).rejects.toMatchObject({
      code: "executable-unavailable",
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});

test("an unavailable executable reports an actionable compiler transport error", async () => {
  await expect(
    invokeTintWorker({
      executable: "/does-not-exist/vgpu-worker",
      request: "{}",
    })
  ).rejects.toMatchObject({
    code: "executable-unavailable",
    message: expect.stringContaining("Tint worker executable"),
    cause: expect.objectContaining({ code: "ENOENT" }),
  });
});

test("an oversized request fails before reading or executing the worker", async () => {
  await expect(
    invokeTintWorker({
      executable: "/does-not-exist/vgpu-worker",
      request: " ".repeat(128 * 1024 * 1024 + 1),
    })
  ).rejects.toMatchObject({ code: "request-too-large" });
});

test("a pre-cancelled invocation fails before reading or executing the worker", async () => {
  const controller = new AbortController();
  controller.abort();

  await expect(
    invokeTintWorker({
      executable: "/does-not-exist/vgpu-worker",
      request: "{}",
      signal: controller.signal,
    })
  ).rejects.toMatchObject({ code: "cancelled" });
});

test("an unknown compiler executable is rejected without running it", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "vgpu-worker-test-"));
  try {
    const executable = join(scratch, "unknown-worker");
    const marker = join(scratch, "executed");
    await writeFile(executable, `#!/bin/sh\ntouch '${marker}'\n`);
    await chmod(executable, 0o700);

    await expect(
      invokeTintWorker({ executable, request: "{}" })
    ).rejects.toMatchObject({
      code: "untrusted-executable",
    });
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
