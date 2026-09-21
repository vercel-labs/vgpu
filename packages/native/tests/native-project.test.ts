import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveShaderSnapshot } from "@vgpu/wgsl/runtime";
import { writeFileSync } from "node:fs";
import { expect, test } from "vitest";
import { loadMetalProject } from "../src/tooling/project.ts";
import type { MetalConfiguration } from "../src/tooling/configuration.ts";
import { fingerprintMetalProject } from "../src/tooling/fingerprint.ts";
import { metalGenerationProfile, type MetalGenerationProfile } from "../src/compatibility.ts";

const docs = new URL("../../../docs/topics/native/macos/metal/", import.meta.url);
const configuration: MetalConfiguration = JSON.parse(
  (await snippets("tooling/native-macos-metal-tooling-configuration.docs.md", "json"))[0]
);
const sources = await snippets("tooling/native-macos-metal-tooling-sources.docs.md", "wgsl");
const gradient = (await snippets("native-macos-metal-uniforms.docs.md", "wgsl"))[0];

test("documented configuration and WGSL become an immutable, replayable compiler input without output", async () => {
  const directory = await fixture();
  try {
    const loaded = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    expect(loaded.filePath).toBe(join(directory, "vgpu.native.json"));
    expect(loaded.configuration).toEqual(configuration);
    expect(loaded.outputPath).toBe(join(directory, configuration.output));
    expect(loaded.sourcePaths.slice().sort()).toEqual([
      "shaders/count.wgsl", "shaders/dimensions.wgsl", "shaders/gradient.wgsl",
    ].map((path) => join(directory, path)).sort());
    expect(loaded.compilerInput.moduleName).toBe("AppShaders");
    expect(loaded.compilerInput.programs).toEqual(
      configuration.programs.slice().sort((a, b) => a.name < b.name ? -1 : 1).map((program) => ({
        ...program,
        source: loaded.compilerInput.snapshot.entries[program.name],
      }))
    );
    expect(loaded.inputFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expectDeeplyFrozen(loaded);
    expect(await readdir(directory)).toEqual(["shaders", "vgpu.native.json"]);
    await rm(directory, { recursive: true, force: true });
    const resolved = await resolveShaderSnapshot(loaded.compilerInput.snapshot, {
      entry: loaded.compilerInput.snapshot.entries.Count, validate: false, minify: false,
    });
    expect(resolved.wgsl).toContain("100u");
    expect(resolved.reflection.entryPoints.map((entry) => entry.stage)).toEqual(["compute"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("relocation, configuration formatting, output destination and program order preserve logical identity", async () => {
  const original = await fixture();
  const moved = `${original}-moved`;
  try {
    const before = await loadMetalProject({ configurationPath: join(original, "vgpu.native.json") });
    await rename(original, moved);
    const reordered = {
      output: "Elsewhere/../GeneratedAgain",
      programs: configuration.programs.slice().reverse().map((program) => ({
        entryPoints: Object.fromEntries(Object.entries(program.entryPoints).reverse()),
        source: `./${program.source}`,
        name: program.name,
      })),
      moduleName: configuration.moduleName,
      schemaVersion: 1,
    };
    await writeFile(join(moved, "renamed-configuration.json"), JSON.stringify(reordered, null, 4));
    const after = await loadMetalProject({ configurationPath: join(moved, "renamed-configuration.json") });
    expect(after.inputFingerprint).toBe(before.inputFingerprint);
    expect(after.compilerInput.programs).toEqual(before.compilerInput.programs);
    expect(after.compilerInput.snapshot.modules).toEqual(before.compilerInput.snapshot.modules);
    expect(after.configuration.output).toBe("Elsewhere/../GeneratedAgain");
    expect(after.sourcePaths.every((path) => path.startsWith(`${moved}/`))).toBe(true);
    expect(after.outputPath).toBe(join(moved, "GeneratedAgain"));
    expect(await readdir(moved)).toEqual(["renamed-configuration.json", "shaders", "vgpu.native.json"]);
  } finally {
    await rm(original, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test("changing an unused imported declaration changes freshness even when emitted WGSL does not", async () => {
  const directory = await fixture();
  try {
    await writeFile(join(directory, "shaders/count.wgsl"), `import { unused } from "./unused.wgsl";\n${sources[0]}`);
    const unused = join(directory, "shaders/unused.wgsl");
    await writeFile(unused, "export const unused: u32 = 1u;");
    const before = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    await writeFile(unused, "export const unused: u32 = 2u;");
    const after = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    expect(before.sourcePaths).toContain(unused);
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
    const emitted = await Promise.all([before, after].map((project) => resolveShaderSnapshot(project.compilerInput.snapshot, {
      entry: project.compilerInput.snapshot.entries.Count, validate: false, minify: false,
    })));
    expect(emitted[0].wgsl).toBe(emitted[1].wgsl);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a package export choosing another captured module changes the fingerprint without changing source bytes", async () => {
  const directory = await fixture();
  try {
    const pkg = join(directory, "node_modules/shader-width");
    await mkdir(pkg, { recursive: true });
    await writeFile(join(pkg, "first.wgsl"), sources[1]);
    await writeFile(join(pkg, "second.wgsl"), sources[1]);
    await writeFile(join(directory, "shaders/count.wgsl"), `
import { width as first } from "../node_modules/shader-width/first.wgsl";
import { width as second } from "../node_modules/shader-width/second.wgsl";
import { width as selected } from "shader-width";
${sources[0]}`);
    const manifest = join(pkg, "package.json");
    await writeFile(manifest, JSON.stringify({ name: "shader-width", exports: { ".": "./first.wgsl" } }));
    const before = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    await writeFile(manifest, JSON.stringify({ name: "shader-width", exports: { ".": "./second.wgsl" } }));
    const after = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    expect(after.compilerInput.snapshot.inputs).toEqual(before.compilerInput.snapshot.inputs);
    const entry = before.compilerInput.snapshot.entries.Count;
    expect(after.compilerInput.snapshot.modules[entry].source).toBe(before.compilerInput.snapshot.modules[entry].source);
    expect(after.compilerInput.snapshot.modules[entry].imports["shader-width"]).not.toBe(before.compilerInput.snapshot.modules[entry].imports["shader-width"]);
    expect(after.inputFingerprint).not.toBe(before.inputFingerprint);
    expect(after.sourcePaths).toEqual(expect.arrayContaining([join(pkg, "first.wgsl"), join(pkg, "second.wgsl")]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("module, program and selected entry points are generation inputs without invoking semantic validation", async () => {
  const directory = await fixture();
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    const before = await loadMetalProject({ configurationPath });
    const variants: MetalConfiguration[] = [
      { ...configuration, moduleName: "OtherShaders" },
      { ...configuration, programs: configuration.programs.map((program) => ({ ...program, name: `${program.name}Again` })) },
      { ...configuration, programs: configuration.programs.map((program) => program.name === "Count" ? { ...program, entryPoints: { compute: "another_main" } } : program) },
      { ...configuration, programs: configuration.programs.map((program) => program.name === "Count" ? { ...program, entryPoints: { vertex: "vertex_main", fragment: "fragment_main" } } : program) },
    ];
    for (const value of variants) {
      await writeFile(configurationPath, JSON.stringify(value));
      const changed = await loadMetalProject({ configurationPath });
      expect(changed.inputFingerprint).not.toBe(before.inputFingerprint);
    }
    expect(await readdir(directory)).toEqual(["shaders", "vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("every generation profile setting affects identity without inspecting installed tools or package versions", async () => {
  const directory = await fixture();
  try {
    const loaded = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    const profile = metalGenerationProfile;
    const variants: MetalGenerationProfile[] = [
      { ...profile, revision: profile.revision + 1 },
      { ...profile, artifactFormat: "vgpu-metal-package/v2" },
      { ...profile, compiler: { ...profile.compiler, name: "another-compiler" } },
      { ...profile, compiler: { ...profile.compiler, version: "0.2.0" } },
      { ...profile, compiler: { ...profile.compiler, protocol: 2 } },
      { ...profile, compiler: { ...profile.compiler, upstream: { ...profile.compiler.upstream, name: "another-upstream" } } },
      { ...profile, compiler: { ...profile.compiler, upstream: { ...profile.compiler.upstream, revision: "0".repeat(40) } } },
      { ...profile, semanticContract: "semantic/v2" },
      { ...profile, translationContract: "translation/v2" },
      { ...profile, metal: { ...profile.metal, sdk: "another-sdk" } },
      { ...profile, metal: { ...profile.metal, languageStandard: "macos-metal3.0" } },
      { ...profile, metal: { ...profile.metal, target: "air64-apple-macos15.0" } },
      { ...profile, swift: { ...profile.swift, toolsVersion: "6.1" } },
      { ...profile, swift: { ...profile.swift, macOSPlatform: "v15" } },
    ];
    expect(fingerprintMetalProject(loaded.compilerInput)).toBe(loaded.inputFingerprint);
    for (const variant of variants) {
      expect(fingerprintMetalProject(loaded.compilerInput, variant)).not.toBe(loaded.inputFingerprint);
    }
    expectDeeplyFrozen(profile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a pre-aborted project load returns the abort reason before reading configuration", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-project-abort-"));
  try {
    const controller = new AbortController();
    const reason = new Error("Project loading cancelled");
    controller.abort(reason);
    await expect(loadMetalProject({
      configurationPath: join(directory, "absent.json"), signal: controller.signal,
    })).rejects.toBe(reason);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dependency callbacks can cancel capture without returning a partial project or publishing output", async () => {
  const directory = await fixture();
  try {
    const controller = new AbortController();
    const reason = new Error("Stop after dependency discovery");
    const dependencies: string[] = [];
    await expect(loadMetalProject({
      configurationPath: join(directory, "vgpu.native.json"),
      signal: controller.signal,
      onDependency(path) { dependencies.push(path); controller.abort(reason); },
    })).rejects.toBe(reason);
    expect(dependencies).toEqual([join(directory, "shaders/dimensions.wgsl")]);
    expect(await readdir(directory)).toEqual(["shaders", "vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("all lexical importer paths survive even when two contexts share one physical source file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-project-contexts-"));
  try {
    const shared = join(directory, "shared.wgsl");
    await writeFile(shared, 'import { value } from "numbers"; export const width: u32 = value;');
    for (const [name, value] of [["left", 2], ["right", 3]] as const) {
      const root = join(directory, name);
      const pkg = join(root, "node_modules/numbers");
      await mkdir(pkg, { recursive: true });
      await writeFile(join(root, "count.wgsl"), sources[0]);
      await symlink(shared, join(root, "dimensions.wgsl"));
      await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "numbers", exports: { ".": "./value.wgsl" } }));
      await writeFile(join(pkg, "value.wgsl"), `export const value: u32 = ${value}u;`);
    }
    const config = {
      ...configuration,
      programs: ["left", "right"].map((name) => ({ name: name === "left" ? "Left" : "Right", source: `${name}/count.wgsl`, entryPoints: { compute: "count_main" } })),
    };
    await writeFile(join(directory, "vgpu.native.json"), JSON.stringify(config));
    const loaded = await loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") });
    expect(loaded.sourcePaths).toHaveLength(6);
    expect(loaded.sourcePaths).toEqual(expect.arrayContaining([join(directory, "left/dimensions.wgsl"), join(directory, "right/dimensions.wgsl")]));
    expect(new Set(await Promise.all(loaded.sourcePaths.map((path) => realpath(path)))).size).toBe(5);
    const snapshot = loaded.compilerInput.snapshot;
    const left = snapshot.inputs.find((input) => input.physicalPath === join(directory, "left/dimensions.wgsl"))!.module;
    const right = snapshot.inputs.find((input) => input.physicalPath === join(directory, "right/dimensions.wgsl"))!.module;
    expect(snapshot.modules[left].source).toBe(snapshot.modules[right].source);
    expect(snapshot.modules[left].imports.numbers).not.toBe(snapshot.modules[right].imports.numbers);
    const replayed = await Promise.all(["Left", "Right"].map((name) => resolveShaderSnapshot(snapshot, { entry: snapshot.entries[name], validate: false, minify: false })));
    expect(replayed[0].wgsl).toContain("= 2u;");
    expect(replayed[1].wgsl).toContain("= 3u;");
    expect(await readdir(directory)).toEqual(["left", "right", "shared.wgsl", "vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("configuration failures retain their diagnostics without discovering shaders or touching output", async () => {
  const directory = await fixture();
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    const dependencies: string[] = [];
    await writeFile(configurationPath, JSON.stringify({ ...configuration, unsupported: true }));
    await rm(join(directory, "shaders"), { recursive: true });
    await expect(loadMetalProject({ configurationPath, onDependency(path) { dependencies.push(path); } })).rejects.toMatchObject({
      name: "MetalConfigurationError", code: "invalid-configuration", filePath: configurationPath,
    });
    expect(dependencies).toEqual([]);
    expect(await readdir(directory)).toEqual(["vgpu.native.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("options are owned before asynchronous reads and configuration is not reread during dependency capture", async () => {
  const directory = await fixture();
  try {
    const configurationPath = join(directory, "vgpu.native.json");
    const dependencies: string[] = [];
    const options = {
      configurationPath,
      signal: new AbortController().signal,
      onDependency(path: string) {
        dependencies.push(path);
        writeFileSync(configurationPath, "{changed after configuration read");
      },
    };
    const pending = loadMetalProject(options);
    options.configurationPath = join(directory, "missing.json");
    options.signal = AbortSignal.abort();
    options.onDependency = () => { throw new Error("Caller replaced callback"); };
    const loaded = await pending;
    expect(loaded.configuration).toEqual(configuration);
    expect(dependencies).toEqual([join(directory, "shaders/dimensions.wgsl")]);
    expectDeeplyFrozen(loaded);
    expect(Reflect.set(loaded.configuration.programs[0].entryPoints, "vertex", "changed")).toBe(false);
    expect(loaded.compilerInput.programs.find((program) => program.name === "Gradient")!.entryPoints).toEqual(configuration.programs[0].entryPoints);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("source capture failure leaves an existing output directory and its bytes unchanged", async () => {
  const directory = await fixture();
  try {
    const output = join(directory, configuration.output);
    await mkdir(output, { recursive: true });
    const marker = join(output, "owned-by-the-application.txt");
    await writeFile(marker, "Do not replace this directory");
    await rm(join(directory, "shaders/dimensions.wgsl"));
    await expect(loadMetalProject({ configurationPath: join(directory, "vgpu.native.json") })).rejects.toThrow();
    expect(await readdir(output)).toEqual(["owned-by-the-application.txt"]);
    expect(await readFile(marker, "utf8")).toBe("Do not replace this directory");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function snippets(path: string, language: string): Promise<string[]> {
  const guide = await readFile(new URL(path, docs), "utf8");
  return [...guide.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```", "gu"))].map((match) => match[1]);
}

async function fixture(config: MetalConfiguration = configuration): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "vgpu-native-project-"));
  for (const [path, source] of Object.entries({
    "vgpu.native.json": JSON.stringify(config),
    "shaders/gradient.wgsl": gradient,
    "shaders/count.wgsl": sources[0],
    "shaders/dimensions.wgsl": sources[1],
  })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), source);
  }
  return directory;
}

function expectDeeplyFrozen(value: unknown): void {
  if (!value || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeeplyFrozen(child);
}
