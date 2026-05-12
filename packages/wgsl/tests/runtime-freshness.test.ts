import { mkdtemp, writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveShader } from "@vgpu/wgsl/runtime";

vi.mock("node:fs/promises", async (importActual) => {
  const actual = await importActual<typeof import("node:fs/promises")>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

describe("resolveShader runtime freshness", () => {
  it("re-reads a mutated transitive .wgsl file on a second resolveShader call", async () => {
    const { entry, helper } = await writeFreshnessFixture();

    const first = await resolveShader({ entry, validate: false });
    await writeFile(helper, helperSource("0.9, 0.8, 0.7, 1.0"));
    const second = await resolveShader({ entry, validate: false });

    expect(second.wgsl).not.toBe(first.wgsl);
    expect(second.wgsl).toContain("0.9, 0.8, 0.7, 1.0");
  });

  it("reads imported .wgsl modules through fs/promises.readFile", async () => {
    const { entry, helper } = await writeFreshnessFixture();
    const readFileMock = vi.mocked(readFile);
    readFileMock.mockClear();

    await resolveShader({ entry, validate: false });

    expect(readFileMock).toHaveBeenCalledWith(helper, "utf8");
  });

  it("preserves clear cycle detection with async sequential recursion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vgsl-cycle-"));
    const a = join(dir, "a.wgsl");
    const b = join(dir, "b.wgsl");
    await writeFile(a, "import { b } from './b.wgsl'; export fn a(){b();}");
    await writeFile(b, "import { a } from './a.wgsl'; export fn b(){a();}");

    await expect(resolveShader({ entry: a, validate: false })).rejects.toMatchObject({ code: "VGPU-WGSL-IMP-SELF" });
  });
});

async function writeFreshnessFixture(): Promise<{ entry: string; helper: string }> {
  const dir = await mkdtemp(join(tmpdir(), "vgsl-fresh-"));
  const entry = join(dir, "entry.wgsl");
  const helper = join(dir, "helper.wgsl");
  await writeFile(helper, helperSource("0.1, 0.2, 0.3, 1.0"));
  await writeFile(entry, "import { helper_color } from './helper.wgsl';\nfn main_color() -> vec4f { return helper_color(); }");
  return { entry, helper };
}

function helperSource(channels: string): string {
  return `export fn helper_color() -> vec4f { return vec4f(${channels}); }`;
}
