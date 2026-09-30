import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test, vi } from "vitest";
import wgslVitePlugin, { transformWgsl } from "../src/loader-vite/index.ts";
import wgslWebpackLoader from "../src/loader-webpack/index.ts";
import { encodePackedMetadata } from "../src/packed/encode.ts";
import {
  encodePackedQuery,
  PACKED_QUERY_KEY,
  PACKED_QUERY_MAX_BYTES,
  packedModuleAssets,
  packedQueryModule,
  normalizePackedResourcePath,
} from "../src/loader-shared/packed-query.ts";

const execFileAsync = promisify(execFile);

test("packed queries are canonical and emit inert standalone table modules", () => {
  const table = encodePackedMetadata({ label: "\ud800", values: [1, 2, 3] });
  expect(table).not.toBeNull();

  const first = encodePackedQuery(table!);
  const second = encodePackedQuery(table!);

  expect(first).toBe(second);
  expect(first).toMatch(/^\?__vgpu_packed_v1=[A-Za-z0-9_-]+$/u);
  expect(first!.slice(first!.indexOf("=") + 1)).not.toContain("=");
  expect(packedQueryModule(packedModuleAssets().anchor, first!)).toBe(
    `export default ${JSON.stringify(table)};`,
  );
});

test("reserved query syntax is strict while unrelated queries retain their existing route", () => {
  const unrelated = ["", "?raw", "?raw=%ZZ", "?other=value#fragment", "?raw=__vgpu_packed_v1"];
  for (const query of unrelated) expect(packedQueryModule("/arbitrary.wgsl", query)).toBeNull();

  const invalid = [
    `?${PACKED_QUERY_KEY}`,
    `?${PACKED_QUERY_KEY}=x&${PACKED_QUERY_KEY}=x`,
    `?${PACKED_QUERY_KEY}=x&raw`,
    `?${PACKED_QUERY_KEY}=x#fragment`,
    `?__vgpu_packed_v2=x`,
    `?__vgpu_packed_%ZZ=x`,
    `?__vgpu%ZZ_packed_v1=x`,
    `?%5F%5Fvgpu%5Fpacked%5Fv1=x`,
    `?${PACKED_QUERY_KEY}=x=y`,
    `?${PACKED_QUERY_KEY}=`,
  ];
  for (const query of invalid) expectPackedError(
    () => packedQueryModule("/arbitrary.wgsl", query),
    "query",
  );
});

test("reserved query length is capped before anchor identity and accepts the exact boundary", () => {
  const prefix = `?${PACKED_QUERY_KEY}=`;
  const atLimit = prefix + "A".repeat(PACKED_QUERY_MAX_BYTES - prefix.length);
  const overLimit = `${atLimit}A`;

  expect(Buffer.byteLength(atLimit, "ascii")).toBe(PACKED_QUERY_MAX_BYTES);
  expectPackedError(() => packedQueryModule("/wrong.wgsl", atLimit), "anchor");
  expectPackedError(() => packedQueryModule("/wrong.wgsl", overLimit), "query");
});

test("only the resolved package anchor may serve packed metadata", async () => {
  const table = encodePackedMetadata(["value"]);
  const query = encodePackedQuery(table!);
  const dir = await mkdtemp(join(tmpdir(), "vgpu-packed-query-"));
  const sameBasename = join(dir, "metadata.wgsl");
  await writeFile(sameBasename, "// unrelated");

  expectPackedError(() => packedQueryModule("/arbitrary.wgsl", query!), "anchor");
  expectPackedError(() => packedQueryModule(sameBasename, query!), "anchor");
  expect(packedQueryModule(`/@fs/${packedModuleAssets().anchor}`, query!)).toContain("export default");
});

test("Vite filesystem resource paths normalize POSIX and Windows-drive forms", () => {
  expect(normalizePackedResourcePath("/@fs/Users/example/metadata.wgsl"))
    .toBe("/Users/example/metadata.wgsl");
  expect(normalizePackedResourcePath("/@fs/C:/repo/metadata.wgsl"))
    .toBe("C:/repo/metadata.wgsl");
  expect(normalizePackedResourcePath("C:\\repo\\metadata.wgsl"))
    .toBe("C:/repo/metadata.wgsl");
});

test("payload parsing rejects invalid base64url, UTF-8, JSON and noncanonical JSON", () => {
  const anchor = packedModuleAssets().anchor;
  const invalidPayloads = [
    "%00",
    "A",
    Buffer.from([0xff]).toString("base64url"),
    Buffer.from("not json", "utf8").toString("base64url"),
    Buffer.from(" [1,[],[],null]", "utf8").toString("base64url"),
  ];
  for (const payload of invalidPayloads) expectPackedError(
    () => packedQueryModule(anchor, `?${PACKED_QUERY_KEY}=${payload}`),
    "query",
  );
});

test("parsed packed tables retain deterministic codec validation errors", () => {
  const anchor = packedModuleAssets().anchor;
  expectPackedError(() => packedQueryModule(anchor, rawQuery([2, [], [], null])), "version");
  expectPackedError(() => packedQueryModule(anchor, rawQuery([1, [], [], [0]])), "reference");

  const nodes: unknown[] = [[-1, 1]];
  for (let index = 1; index < 21; index++) nodes.push([-1, [index - 1], [index - 1]]);
  expectPackedError(() => packedQueryModule(anchor, rawQuery([1, [], nodes, [20]])), "limit");
});

test("query encoding returns null instead of emitting an over-cap producer request", () => {
  let lastAccepted: string | null = null;
  let rejected = false;
  for (let length = 2_000; length < 4_000; length++) {
    const table = encodePackedMetadata("x".repeat(length));
    const query = encodePackedQuery(table!);
    if (query === null) {
      rejected = true;
      break;
    }
    lastAccepted = query;
  }
  expect(lastAccepted).not.toBeNull();
  expect(Buffer.byteLength(lastAccepted!, "ascii")).toBe(PACKED_QUERY_MAX_BYTES);
  expect(rejected).toBe(true);
});

test("loader metadata branches are early, synchronous and source-independent", async () => {
  const table = encodePackedMetadata({ metadata: [1, 2, 3] });
  const query = encodePackedQuery(table!);
  const id = `${packedModuleAssets().anchor}${query}`;
  const getOptions = vi.fn(() => { throw new Error("must not read options"); });
  const asyncMode = vi.fn(() => { throw new Error("must stay synchronous"); });
  const addDependency = vi.fn();

  const webpackCode = wgslWebpackLoader.call({
    resourcePath: packedModuleAssets().anchor,
    resourceQuery: query!,
    getOptions,
    async: asyncMode,
    addDependency,
  }, "this is not WGSL");
  expect(webpackCode).toBe(`export default ${JSON.stringify(table)};`);
  expect(getOptions).not.toHaveBeenCalled();
  expect(asyncMode).not.toHaveBeenCalled();
  expect(addDependency).not.toHaveBeenCalled();

  expectPackedError(() => wgslWebpackLoader.call({
    resourcePath: packedModuleAssets().anchor,
    resourceQuery: query!,
    resourceFragment: "#fragment",
  }, "this is not WGSL"), "query");

  const onDependency = vi.fn();
  await expect(transformWgsl({ source: "not WGSL", id, onDependency })).resolves.toEqual({
    code: `export default ${JSON.stringify(table)};`,
    map: null,
  });
  expect(onDependency).not.toHaveBeenCalled();

  const addWatchFile = vi.fn();
  await expect(wgslVitePlugin().transform.call({ addWatchFile }, "also not WGSL", id)).resolves.toEqual({
    code: `export default ${JSON.stringify(table)};`,
    map: null,
  });
  expect(addWatchFile).not.toHaveBeenCalled();
});

test("unrelated Vite queries preserve direct-transform behavior and the plugin filter", async () => {
  const source = "@compute @workgroup_size(1) fn main() {}";
  const id = "/ordinary.wgsl?raw";
  const addWatchFile = vi.fn();

  await expect(wgslVitePlugin().transform.call({ addWatchFile }, source, id)).resolves.toBeNull();
  await expect(transformWgsl(source, id)).resolves.toMatchObject({ code: expect.stringContaining("export default"), map: null });
  expect(addWatchFile).not.toHaveBeenCalled();
});

test("built asset resolution is self-contained under spaces, symlinks and a transitive install", async () => {
  const root = await mkdtemp(join(tmpdir(), "vgpu packed isolated "));
  const scope = join(root, "node_modules", "vgpu", "node_modules", "@vgpu");
  const packageLink = join(scope, "wgsl");
  await mkdir(scope, { recursive: true });
  await symlink(resolve("packages/wgsl"), packageLink, "dir");
  const queryModule = pathToFileURL(join(packageLink, "dist", "loader-shared", "packed-query.js")).href;
  const script = `import { packedModuleAssets } from ${JSON.stringify(queryModule)}; console.log(JSON.stringify(packedModuleAssets()));`;
  const { stdout } = await execFileAsync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", script], { cwd: root });
  const resolved = JSON.parse(stdout) as { readonly decoder: string; readonly anchor: string };

  expect(resolved).toEqual({
    decoder: (await realpath(resolve("packages/wgsl/dist/packed-metadata.js"))).replace(/\\/gu, "/"),
    anchor: (await realpath(resolve("packages/wgsl/src/metadata.wgsl"))).replace(/\\/gu, "/"),
  });
});

function rawQuery(table: unknown): string {
  return `?${PACKED_QUERY_KEY}=${Buffer.from(JSON.stringify(table), "utf8").toString("base64url")}`;
}

function expectPackedError(run: () => unknown, reason: string): void {
  expect(run).toThrow(expect.objectContaining({
    code: "VGPU-WGSL-PACKED-METADATA-INVALID",
    fix: "Rebuild with compatible @vgpu/wgsl loader assets.",
    message: `Invalid packed WGSL metadata: ${reason}. Rebuild with compatible @vgpu/wgsl loader assets.`,
  }));
}
