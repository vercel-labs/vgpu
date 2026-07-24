import { describe, expect, test } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExamples } from "../../lib/examples/run.js";
import { searchExamples } from "../../lib/examples/search.js";
import { assertSafeRelativePath, assertUniquePaths } from "../../lib/examples/paths.js";
import { pullExample } from "../../lib/examples/pull.js";

const hash = "a".repeat(64);

describe("examples grammar", () => {
  test("documents safe canonical commands", async () => {
    const result = await runExamples(["--help"]);
    expect(result).toMatchObject({ code: 0 });
    expect(result.stdout).toContain("npx vgpu examples");
    expect(result.stdout).toContain("never executes code");
    expect(result.stdout).not.toContain("--base-url");
  });

  test.each([
    ["get", "x"], ["file", "x", "a.ts"], ["search"],
    ["search", "x", "--limit", "0"], ["cat", "x", "a.ts", "--pretty"],
    ["pull", "x"], ["show", "x", "--offline", "--offline"],
  ])("rejects malformed grammar %#", async (...args: string[]) => {
    const result = await runExamples(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBeUndefined();
    expect(JSON.parse(result.stderr!).error.code).toBe("VGPU-EXAMPLES-USAGE");
  });
});

test("search is deterministic, weighted, and aliases raymarch morphology", () => {
  const index = { examples: [
    { id: "other", title: "Raymarch notes", tags: [], capabilities: [], description: "raymarch" },
    { id: "raymarched-fractal", title: "Fractal", tags: ["raymarching"], capabilities: ["hdr"], description: "Sierpinski" },
  ] } as any;
  expect(searchExamples(index, "raymarching").map((x) => x.id)).toEqual(["raymarched-fractal", "other"]);
  expect(searchExamples(index, "hdr sierpinski").map((x) => x.id)).toEqual(["raymarched-fractal"]);
});

test("rejects traversal, encoding, control, drive, UNC and collisions", () => {
  for (const path of ["../x", "a/../x", "%2e%2e/x", "C:/x", "\\\\host\\x", "a\\b", "/x", "a\0b"])
    expect(() => assertSafeRelativePath(path)).toThrow();
  expect(() => assertUniquePaths([{ path: "A.ts" }, { path: "a.ts" }] as any)).toThrow();
});

test("pull publishes atomically, refuses existing destination, and force replaces instead of merging", async () => {
  const root = await mkdtemp(join(tmpdir(), "examples-pull-"));
  const destination = join(root, "example");
  const manifest = { revision: hash, files: [{ path: "nested/a.ts", size: 4, sha256: hash }] } as any;
  const client = { getFile: async () => Buffer.from("new\n") } as any;
  await pullExample(client, manifest, destination);
  expect(await readFile(join(destination, "nested/a.ts"), "utf8")).toBe("new\n");
  await expect(pullExample(client, manifest, destination)).rejects.toMatchObject({ exitCode: 6, code: "VGPU-EXAMPLES-DESTINATION-EXISTS" });
  await writeFile(join(destination, "old.ts"), "old");
  await pullExample(client, manifest, destination, { force: true });
  expect(await readFile(join(destination, "nested/a.ts"), "utf8")).toBe("new\n");
  await expect(readFile(join(destination, "old.ts"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("pull rejects a symlink destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "examples-pull-link-"));
  await mkdir(join(root, "real"));
  const { symlink } = await import("node:fs/promises");
  await symlink(join(root, "real"), join(root, "out"));
  const manifest = { revision: hash, files: [{ path: "a.ts", size: 1, sha256: hash }] } as any;
  await expect(pullExample({ getFile: async () => Buffer.from("x") } as any, manifest, join(root, "out"), { force: true })).rejects.toMatchObject({ exitCode: 7 });
});
