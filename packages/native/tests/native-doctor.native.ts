import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import { doctorMetalToolchain } from "../src/tooling/doctor.ts";

const workerPath = fileURLToPath(
  new URL(
    "../../../tooling/native-tint-worker/c1-tint-direct-build/.artifacts/bin/vgpu-tint-worker-arm64",
    import.meta.url
  )
);

test("the real native doctor checks the selected tools, authenticated Tint and actual Metal compile/link without GPU or project output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-doctor-test-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  try {
    const report = await doctorMetalToolchain({ workerPath });
    expect(report).toEqual({
      schemaVersion: 1,
      target: "macos",
      verdict: "healthy",
      findings: ["node", "host", "xcode", "sdk", "swift", "tint", "metal"].map(
        (probe) => ({ probe, status: "ok", evidence: expect.any(String) })
      ),
    });
    expect(report.findings[0].evidence).toContain(process.versions.node);
    expect(report.findings[1].evidence).toContain(process.arch);
    expect(report.findings[5].evidence).toContain(
      "8f25b9c7064ae89802c8db4e7daab9d1fd3e77ca"
    );
    expect(await readdir(directory)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("a real diagnostic pins its original Xcode selection despite later ambient changes", async () => {
  const previous = process.env.DEVELOPER_DIR;
  try {
    const pending = doctorMetalToolchain({ workerPath });
    process.env.DEVELOPER_DIR = "/missing/changed-after-start/Xcode.app";
    const report = await pending;
    expect(report.verdict).toBe("healthy");
    expect(report.findings[2].evidence).not.toContain("changed-after-start");
    expect(report.findings[6].status).toBe("ok");
  } finally {
    if (previous === undefined) delete process.env.DEVELOPER_DIR;
    else process.env.DEVELOPER_DIR = previous;
  }
});
