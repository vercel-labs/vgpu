import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { captureShaderGraph, resolveShaderSnapshot, type CaptureShaderGraphOptions } from "../src/runtime/resolve-shader.ts";

const guide = readFileSync(new URL("../../../docs/topics/native/macos/metal/tooling/native-macos-metal-tooling-sources.docs.md", import.meta.url), "utf8");
const sources = [...guide.matchAll(/```wgsl\n([\s\S]*?)\n```/gu)].map((match) => match[1]);
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function project(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vgpu-graph-snapshot-test-"));
  temporary.push(path);
  await mkdir(join(path, "shaders"));
  await writeFile(join(path, "shaders/count.wgsl"), sources[0]);
  await writeFile(join(path, "shaders/dimensions.wgsl"), sources[1]);
  return path;
}

test("the documented WGSL graph resolves from captured source after its original files change and disappear", async () => {
  expect(sources).toHaveLength(2);
  const rootDir = await project();
  const snapshot = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  await writeFile(join(rootDir, "shaders/dimensions.wgsl"), sources[1].replace("2u", "3u"));
  await rm(join(rootDir, "shaders"), { recursive: true });
  const shader = await resolveShaderSnapshot(snapshot, { entry: snapshot.entries.Count, validate: false, minify: false });
  expect(shader.reflection.entryPoints).toEqual([expect.objectContaining({ name: "count_main", stage: "compute" })]);
  expect(shader.wgsl).toContain("= 2u;");
  expect(shader.wgsl).not.toContain("= 3u;");
  expect(Object.values(snapshot.modules).map((module) => module.source).sort()).toEqual([...sources].sort());
  expect([...shader.deps].sort()).toEqual(Object.keys(snapshot.modules).sort());
});

test("a serialized owned snapshot replays without consulting informational physical paths", async () => {
  const rootDir = await project();
  const captured = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  const original = await resolveShaderSnapshot(captured, { entry: captured.entries.Count, validate: false });
  const clone = JSON.parse(JSON.stringify(captured));
  for (const input of clone.inputs) input.physicalPath = "/missing/informational-only.wgsl";
  const replayed = await resolveShaderSnapshot(clone, { entry: clone.entries.Count, validate: false });
  expect(replayed.wgsl).toBe(original.wgsl);
  expect(replayed.reflection).toEqual(original.reflection);
});

test("configured entries share one captured dependency read and expose owned immutable data", async () => {
  const rootDir = await project();
  const shared = join(rootDir, "shaders/dimensions.wgsl");
  const trigger = join(rootDir, "shaders/trigger.wgsl");
  const second = join(rootDir, "shaders/second.wgsl");
  await writeFile(trigger, "export fn unused() {}");
  await writeFile(second, `import { unused } from "./trigger.wgsl"; import { width } from "./dimensions.wgsl"; @compute @workgroup_size(width) fn second_main() {}`);
  const dependencies: string[] = [];
  const snapshot = await captureShaderGraph({
    rootDir, entries: { Second: second, Count: join(rootDir, "shaders/count.wgsl") },
    onDependency(path) {
      dependencies.push(path);
      if (path === trigger) writeFileSync(shared, sources[1].replace("2u", "3u"));
    },
  });
  expect(dependencies).toEqual([shared, trigger]);
  const sharedId = snapshot.inputs.find((input) => input.physicalPath === shared)!.module;
  expect(snapshot.modules[sharedId].source).toBe(sources[1]);
  expect(Reflect.set(snapshot.modules[sharedId], "source", "changed")).toBe(false);
  expect(Reflect.set(snapshot.entries, "Second", "changed")).toBe(false);
  expect((await resolveShaderSnapshot(snapshot, { entry: snapshot.entries.Second, validate: false })).wgsl).toContain("= 2u;");
});

test("capture rejects malformed UTF-8 and NUL bytes instead of replacing or truncating them", async () => {
  const rootDir = await project();
  const path = join(rootDir, "shaders/count.wgsl");
  for (const bytes of [Buffer.from([47, 47, 0xc3, 0x28]), Buffer.from("// embedded\0byte")]) {
    await writeFile(path, bytes);
    await expect(captureShaderGraph({ rootDir, entries: { Count: path } })).rejects.toThrow(/UTF-8|NUL/);
  }
});

test("capture rejects nonregular source targets", async () => {
  const rootDir = await project();
  const path = join(rootDir, "shaders/device.wgsl");
  await symlink("/dev/null", path);
  await expect(captureShaderGraph({ rootDir, entries: { Device: path } })).rejects.toThrow(/regular file/);
});

test("capture accepts four MiB per module and rejects the next byte", async () => {
  const rootDir = await project();
  const path = join(rootDir, "shaders/large.wgsl");
  const source = "//" + "a".repeat(4 * 1024 * 1024 - 2);
  await writeFile(path, source);
  const snapshot = await captureShaderGraph({ rootDir, entries: { Large: path } });
  expect(snapshot.modules[snapshot.entries.Large].source.length).toBe(source.length);
  await writeFile(path, source + "a");
  const error = await captureShaderGraph({ rootDir, entries: { Large: path } }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/4 MiB/);
});

test("capture counts shared modules once and bounds total captured bytes to thirty-two MiB", async () => {
  const rootDir = await project();
  const source = "//" + "a".repeat(4 * 1024 * 1024 - 2);
  const entries: Record<string, string> = {};
  for (let index = 0; index < 8; index++) {
    const path = join(rootDir, `large${index}.wgsl`);
    await writeFile(path, source);
    entries[`Large${index}`] = path;
  }
  entries.Alias = entries.Large0;
  expect((await captureShaderGraph({ rootDir, entries })).inputs).toHaveLength(8);
  entries.Extra = join(rootDir, "extra.wgsl");
  await writeFile(entries.Extra, " ");
  const error = await captureShaderGraph({ rootDir, entries }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/32 MiB/);
});

test("capture bounds graph width to 1024 modules", async () => {
  const rootDir = await project();
  const entries: Record<string, string> = {};
  for (let index = 0; index < 1024; index++) {
    entries[String(index)] = join(rootDir, `module${index}.wgsl`);
    await writeFile(entries[String(index)], "");
  }
  expect((await captureShaderGraph({ rootDir, entries })).inputs).toHaveLength(1024);
  entries.Extra = join(rootDir, "extra.wgsl");
  await writeFile(entries.Extra, "");
  const error = await captureShaderGraph({ rootDir, entries }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/1024 modules/);
});

test("capture bounds every import chain to 128 modules", async () => {
  const rootDir = await project();
  for (let index = 0; index < 128; index++) {
    await writeFile(join(rootDir, `chain${index}.wgsl`), index === 127 ? "export const value = 1u;" : `import { value } from "./chain${index + 1}.wgsl"; export const local${index} = value;`);
  }
  const entries = { Chain: join(rootDir, "chain0.wgsl") };
  expect((await captureShaderGraph({ rootDir, entries })).inputs).toHaveLength(128);
  await writeFile(join(rootDir, "chain127.wgsl"), 'import { value } from "./chain128.wgsl";');
  await writeFile(join(rootDir, "chain128.wgsl"), "export const value = 1u;");
  await expect(captureShaderGraph({ rootDir, entries })).rejects.toThrow(/128 modules.*chain/);
});

test("a previously visited entry cannot hide an overlong import chain", async () => {
  const rootDir = await project();
  for (let index = 0; index < 129; index++) {
    await writeFile(join(rootDir, `chain${index}.wgsl`), index === 128 ? "export const value = 1u;" : `import { value } from "./chain${index + 1}.wgsl";`);
  }
  const entries = { A: join(rootDir, "chain1.wgsl"), B: join(rootDir, "chain0.wgsl") };
  const error = await captureShaderGraph({ rootDir, entries }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/128 modules.*chain/);
});

test("capture honors pre-aborted and dependency-triggered cancellation", async () => {
  const rootDir = await project();
  const entries = { Count: join(rootDir, "shaders/count.wgsl") };
  const controller = new AbortController();
  controller.abort();
  await expect(captureShaderGraph({ rootDir, entries, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
  const during = new AbortController();
  await expect(captureShaderGraph({ rootDir, entries, signal: during.signal, onDependency() { during.abort(); } })).rejects.toMatchObject({ name: "AbortError" });
});

test("capture snapshots caller configuration before asynchronous reads", async () => {
  const rootDir = await project();
  const path = join(rootDir, "shaders/count.wgsl");
  await writeFile(path, sources[0].replace("./dimensions.wgsl", "@/shaders/dimensions.wgsl"));
  const options = { rootDir, entries: { Count: path } };
  const pending = captureShaderGraph(options);
  options.rootDir = "/missing";
  options.entries.Count = "/missing.wgsl";
  const snapshot = await pending;
  expect(snapshot.inputs.map((input) => input.physicalPath)).toEqual([path, join(rootDir, "shaders/dimensions.wgsl")]);
});

test("capture requires an absolute root and at least one named absolute entry", async () => {
  const rootDir = await project();
  const path = join(rootDir, "shaders/count.wgsl");
  const cases: CaptureShaderGraphOptions[] = [
    { rootDir: ".", entries: { Count: path } },
    { rootDir, entries: {} },
    { rootDir, entries: { "": path } },
    { rootDir, entries: { Count: "packages/wgsl/tests/fixtures/imports/basic/entry.wgsl" } },
  ];
  for (const options of cases) {
    const error = await captureShaderGraph(options).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
  }
});

test("replay rejects source bytes whose recorded hash no longer matches", async () => {
  const rootDir = await project();
  const snapshot = JSON.parse(JSON.stringify(await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } })));
  snapshot.modules[snapshot.entries.Count].source += "\n// changed";
  await expect(resolveShaderSnapshot(snapshot, { entry: snapshot.entries.Count, validate: false })).rejects.toThrow(/sha256/);
});

test("replay requires the exact versioned data shape and one hash record for every module", async () => {
  const rootDir = await project();
  const captured = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  const mutations: ((snapshot: any) => void)[] = [
    (s) => { s.schemaVersion = 2; },
    (s) => { s.extra = true; },
    (s) => { s.entries = {}; },
    (s) => { s.modules[s.entries.Count].extra = true; },
    (s) => { s.inputs = []; },
    (s) => { s.inputs[1] = s.inputs[0]; },
    (s) => { s.inputs[0].extra = true; },
    (s) => { s.inputs[0].physicalPath = 1; },
    (s) => { s.entries.Count = "/existing/file.wgsl"; },
    (s) => { s.modules["/existing/file.wgsl"] = s.modules[s.entries.Count]; },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(captured);
    mutate(snapshot);
    const error = await resolveShaderSnapshot(snapshot, { entry: captured.entries.Count, validate: false }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
  }
});

test("replay rejects missing, additional, unknown and unreachable import edges without filesystem fallback", async () => {
  const rootDir = await project();
  const captured = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  const mutations: ((snapshot: any) => void)[] = [
    (s) => { s.modules[s.entries.Count].imports["./extra.wgsl"] = s.entries.Count; },
    (s) => { delete s.modules[s.entries.Count].imports["./dimensions.wgsl"]; },
    (s) => { s.modules[s.entries.Count].imports["./dimensions.wgsl"] = "modules/0999.wgsl"; },
    (s) => {
      s.modules["modules/0999.wgsl"] = structuredClone(s.modules["modules/0001.wgsl"]);
      s.inputs.push({ ...s.inputs[1], module: "modules/0999.wgsl" });
    },
  ];
  for (const mutate of mutations) {
    const snapshot = structuredClone(captured);
    mutate(snapshot);
    const error = await resolveShaderSnapshot(snapshot, { entry: captured.entries.Count, validate: false }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
  }
});

test("replay applies source byte and UTF-8 bounds even when forged hashes are consistent", async () => {
  const rootDir = await project();
  const captured = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  for (const source of ["//" + "a".repeat(4 * 1024 * 1024), "//\0", "//\ud800"]) {
    const snapshot = JSON.parse(JSON.stringify(captured));
    snapshot.modules[snapshot.entries.Count].source = source;
    snapshot.modules[snapshot.entries.Count].imports = {};
    snapshot.inputs[0].sha256 = createHash("sha256").update(source).digest("hex");
    delete snapshot.modules["modules/0001.wgsl"];
    snapshot.inputs.pop();
    const error = await resolveShaderSnapshot(snapshot, { entry: snapshot.entries.Count, validate: false }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).toMatch(/4 MiB|UTF-8|NUL/);
  }
});

test("replay bounds the complete serialized graph before emission", async () => {
  function graph(count: number, sourceOf: (index: number) => string, chained = false) {
    const snapshot: any = { schemaVersion: 1, entries: {}, modules: {}, inputs: [] };
    for (let index = 0; index < count; index++) {
      const id = `modules/${String(index).padStart(4, "0")}.wgsl`;
      const source = sourceOf(index);
      snapshot.modules[id] = { source, imports: chained && index < count - 1 ? { "./next.wgsl": `modules/${String(index + 1).padStart(4, "0")}.wgsl` } : {} };
      snapshot.inputs.push({ module: id, physicalPath: "/never/read", sha256: createHash("sha256").update(source).digest("hex") });
      if (!chained || index === 0) snapshot.entries[String(index)] = id;
    }
    return snapshot;
  }
  const cases = [
    [graph(1025, () => ""), /1024 modules/],
    [graph(9, () => "//" + "a".repeat(4 * 1024 * 1024 - 2)), /32 MiB/],
    [graph(129, (index) => index === 128 ? "" : 'import { value } from "./next.wgsl";', true), /128 modules.*chain/],
  ] as const;
  for (const [snapshot, message] of cases) {
    const error = await resolveShaderSnapshot(snapshot, { entry: snapshot.entries[0], validate: false }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(RangeError);
    expect(String(error)).toMatch(message);
  }
});

test("replay snapshots options and data before its first asynchronous step", async () => {
  const rootDir = await project();
  const snapshot = JSON.parse(JSON.stringify(await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } })));
  const options = { entry: snapshot.entries.Count, validate: false, minify: { whitespace: false as boolean } };
  const pending = resolveShaderSnapshot(snapshot, options);
  options.entry = "missing";
  options.minify.whitespace = true;
  snapshot.modules[snapshot.entries.Count].source = "changed";
  const shader = await pending;
  expect(shader.wgsl).toContain("// shaders/count.wgsl");
  expect(shader.reflection.entryPoints[0].name).toBe("count_main");
});

test("virtual identity follows sorted caller keys even for integer-like names and survives relocation", async () => {
  async function capture() {
    const rootDir = await project();
    const a = join(rootDir, "a.wgsl");
    const b = join(rootDir, "b.wgsl");
    await writeFile(a, "// alpha");
    await writeFile(b, "// beta");
    return captureShaderGraph({ rootDir, entries: { "2": b, "10": a } });
  }
  const first = await capture();
  expect(first.inputs.map((input) => first.modules[input.module].source)).toEqual(["// alpha", "// beta"]);
  const moved = await capture();
  expect(moved.entries).toEqual(first.entries);
  expect(moved.modules).toEqual(first.modules);
  expect(moved.inputs.map(({ module, sha256 }) => ({ module, sha256 }))).toEqual(first.inputs.map(({ module, sha256 }) => ({ module, sha256 })));
  expect(moved.inputs[0].physicalPath).not.toBe(first.inputs[0].physicalPath);
  expect((await resolveShaderSnapshot(moved, { entry: moved.entries["10"], validate: false })).wgsl).toBe((await resolveShaderSnapshot(first, { entry: first.entries["10"], validate: false })).wgsl);
});

test("lexical symlink importers preserve different nested npm dependency contexts", async () => {
  const rootDir = await project();
  await mkdir(join(rootDir, ".git"));
  const shared = join(rootDir, "shared.wgsl");
  await writeFile(shared, 'import { value } from "numbers"; export fn answer() -> u32 { return value; }');
  const entries: Record<string, string> = {};
  for (const [name, value] of [["A", 11], ["B", 22]] as const) {
    const dir = join(rootDir, name);
    const pkg = join(dir, "node_modules/numbers");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "numbers", exports: { ".": "./value.wgsl" } }));
    await writeFile(join(pkg, "value.wgsl"), `export const value = ${value}u;`);
    await symlink(shared, join(dir, "helper.wgsl"));
    const path = join(dir, "entry.wgsl");
    await writeFile(path, 'import { answer } from "./helper.wgsl"; @compute @workgroup_size(1) fn main() { let x = answer(); }');
    entries[name] = path;
  }
  const captured = await captureShaderGraph({ rootDir, entries });
  expect(Object.values(captured.modules).filter((module) => module.source.includes('from "numbers"'))).toHaveLength(2);
  await rm(join(rootDir, "A"), { recursive: true });
  await rm(join(rootDir, "B"), { recursive: true });
  const a = await resolveShaderSnapshot(captured, { entry: captured.entries.A, validate: false });
  const b = await resolveShaderSnapshot(captured, { entry: captured.entries.B, validate: false });
  expect(a.wgsl).toContain("= 11u");
  expect(a.wgsl).not.toContain("= 22u");
  expect(b.wgsl).toContain("= 22u");
  expect(b.wgsl).not.toContain("= 11u");
});

test("capture rejects oversized package manifests before selecting exports", async () => {
  const rootDir = await project();
  const pkg = join(rootDir, "node_modules/dimensions");
  await mkdir(pkg, { recursive: true });
  const manifest = JSON.stringify({ name: "dimensions", exports: { ".": "./index.wgsl" } });
  await writeFile(join(pkg, "index.wgsl"), sources[1]);
  const path = join(rootDir, "shaders/count.wgsl");
  await writeFile(path, sources[0].replace("./dimensions.wgsl", "dimensions"));
  await writeFile(join(pkg, "package.json"), manifest.padEnd(1024 * 1024));
  expect((await captureShaderGraph({ rootDir, entries: { Count: path } })).inputs).toHaveLength(2);
  await writeFile(join(pkg, "package.json"), manifest.padEnd(1024 * 1024 + 1));
  const error = await captureShaderGraph({ rootDir, entries: { Count: path } }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(RangeError);
  expect(String(error)).toMatch(/1 MiB/);
});

test("capture rejects malformed UTF-8 and nonregular package manifests", async () => {
  const rootDir = await project();
  const pkg = join(rootDir, "node_modules/dimensions");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "index.wgsl"), sources[1]);
  const path = join(rootDir, "shaders/count.wgsl");
  await writeFile(path, sources[0].replace("./dimensions.wgsl", "dimensions"));
  const manifest = join(pkg, "package.json");
  await writeFile(manifest, Buffer.concat([Buffer.from('{"name":"'), Buffer.from([0xc3, 0x28]), Buffer.from('","exports":{".":"./index.wgsl"}}')]));
  await expect(captureShaderGraph({ rootDir, entries: { Count: path } })).rejects.toThrow(/UTF-8/);
  await rm(manifest);
  await symlink("/dev/null", manifest);
  await expect(captureShaderGraph({ rootDir, entries: { Count: path } })).rejects.toThrow(/regular file/);
});

test("replay rejects sparse or accessor input records without invoking caller code", async () => {
  const rootDir = await project();
  const captured = await captureShaderGraph({ rootDir, entries: { Count: join(rootDir, "shaders/count.wgsl") } });
  const sparse = structuredClone(captured);
  delete (sparse.inputs as any)[0];
  const missing = await resolveShaderSnapshot(sparse, { entry: captured.entries.Count, validate: false }).then(() => undefined, (error: unknown) => error);
  expect(missing).toBeInstanceOf(TypeError);
  const accessor = structuredClone(captured);
  let invoked = false;
  Object.defineProperty(accessor.inputs, "0", { enumerable: true, get() { invoked = true; return captured.inputs[0]; } });
  const error = await resolveShaderSnapshot(accessor, { entry: captured.entries.Count, validate: false }).then(() => undefined, (error: unknown) => error);
  expect(error).toBeInstanceOf(TypeError);
  expect(invoked).toBe(false);
});

test("capture and serialized replay reject import cycles", async () => {
  const rootDir = await project();
  const entry = join(rootDir, "a.wgsl");
  await writeFile(entry, 'import { value } from "./b.wgsl";');
  await writeFile(join(rootDir, "b.wgsl"), 'import { value } from "./a.wgsl";');
  await expect(captureShaderGraph({ rootDir, entries: { Cycle: entry } })).rejects.toThrow(/Import cycle/);
  const source = 'import { value } from "./self.wgsl";';
  const snapshot = { schemaVersion: 1 as const, entries: { Cycle: "modules/0000.wgsl" }, modules: { "modules/0000.wgsl": { source, imports: { "./self.wgsl": "modules/0000.wgsl" } } }, inputs: [{ module: "modules/0000.wgsl", physicalPath: entry, sha256: createHash("sha256").update(source).digest("hex") }] };
  await expect(resolveShaderSnapshot(snapshot, { entry: snapshot.entries.Cycle, validate: false })).rejects.toThrow(/Import cycle/);
});

test("snapshot IDs cannot carry path separators or trailing control characters", async () => {
  for (const id of ["modules/0000.wgsl\n", "modules/../escape.wgsl", "modules\\0000.wgsl"]) {
    const snapshot = { schemaVersion: 1 as const, entries: { Empty: id }, modules: { [id]: { source: "", imports: {} } }, inputs: [{ module: id, physicalPath: "/unused", sha256: createHash("sha256").update("").digest("hex") }] };
    const error = await resolveShaderSnapshot(snapshot, { entry: id, validate: false }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(TypeError);
  }
});

test.skipIf(process.platform === "win32")("FIFO source and manifest targets fail promptly without waiting for a writer", async () => {
  const rootDir = await project();
  const source = join(rootDir, "fifo.wgsl");
  execFileSync("mkfifo", [source], { timeout: 5000 });
  const runtime = new URL("../src/runtime/resolve-shader.ts", import.meta.url).href;
  async function rejectNonregular(entry: string): Promise<void> {
    const code = `import { captureShaderGraph } from ${JSON.stringify(runtime)};
      await captureShaderGraph(${JSON.stringify({ rootDir, entries: { Test: entry } })}).then(
        () => { throw new Error("Expected regular file rejection"); },
        (error) => { if (!/must be a regular file/.test(error.message)) throw error; });`;
    await promisify(execFile)(process.execPath, ["--experimental-transform-types", "--input-type=module", "-e", code], { timeout: 5000 });
  }
  await rejectNonregular(source);
  const pkg = join(rootDir, "node_modules/fifo");
  await mkdir(pkg, { recursive: true });
  execFileSync("mkfifo", [join(pkg, "package.json")], { timeout: 5000 });
  const entry = join(rootDir, "entry.wgsl");
  await writeFile(entry, 'import { value } from "fifo";');
  await rejectNonregular(entry);
});

test("capture requires rootDir to identify an existing directory", async () => {
  const rootDir = await project();
  const entry = join(rootDir, "shaders/count.wgsl");
  for (const invalidRoot of [entry, join(rootDir, "missing")]) {
    const error = await captureShaderGraph({ rootDir: invalidRoot, entries: { Count: entry } }).then(() => undefined, (error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
  }
});

test("colon-containing filenames cannot collide with another module's cached source", async () => {
  const rootDir = await project();
  const first = join(rootDir, "entry.wgsl:const name");
  const second = join(rootDir, "entry.wgsl");
  await writeFile(first, "u32 = 7u;");
  await writeFile(second, "const name:u32 = 7u;");
  await captureShaderGraph({ rootDir, entries: { First: first } });
  const snapshot = await captureShaderGraph({ rootDir, entries: { Second: second } });
  expect(snapshot.modules[snapshot.entries.Second].source).toBe("const name:u32 = 7u;");
  expect(snapshot.inputs[0].sha256).toBe(createHash("sha256").update("const name:u32 = 7u;").digest("hex"));
});
