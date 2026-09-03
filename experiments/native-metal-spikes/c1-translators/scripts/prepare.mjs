import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = resolve(process.env.C1_FIXTURE_DIR ?? join(scriptDir, ".."));
const repoRoot = resolve(process.env.C1_REPO_ROOT ?? join(fixtureDir, "../../.."));
const artifactsDir = resolve(process.env.C1_ARTIFACTS_DIR ?? join(fixtureDir, ".artifacts"));
const mode = process.argv.includes("--full") ? "full" : "quick";
const preparedDir = join(artifactsDir, "prepared");

await rm(preparedDir, { recursive: true, force: true });
await mkdir(preparedDir, { recursive: true });

const { reflectSource } = await import(
  pathToFileURL(join(repoRoot, "packages/wgsl/dist/runtime/reflect-source.js")).href
);

const canaries = [
  { name: "alignment-and-io", contract: "valid", tint: "success", naga: "success" },
  { name: "uniform-standard-layout", contract: "valid", tint: "success", naga: "failure", reason: "uniform_buffer_standard_layout is unsupported by Naga 30.0.1" },
  { name: "binding-slots", contract: "valid", tint: "success", naga: "success" },
  { name: "multiple-entry-points", contract: "valid", tint: "success", naga: "success" },
  { name: "typed-overrides", contract: "valid", tint: "success", naga: "success" },
  { name: "invalid", contract: "invalid", tint: "failure", naga: "failure" },
];

const resolverNegatives = new Map([
  ["packages/vgpu-api/tests/fixtures/bool-uniform.wgsl", "VGPU-WGSL-REFLECT-BOOL-HOST-SHAREABLE"],
  ["packages/vgpu-api/tests/fixtures/module-binding-entry.wgsl", "VGPU-RESOLVE-MODULE-BINDING"],
]);
const translatorNegative = "packages/vgpu-api/tests/fixtures/reserved-word.wgsl";
const nagaExtensionFailures = new Set([
  "apps/docs/examples/fft-ocean-surface/fft-col.wgsl",
  "apps/docs/examples/fft-ocean-surface/fft-core.wgsl",
  "apps/docs/examples/fft-ocean-surface/fft-row.wgsl",
]);
const overrideSelections = new Map([
  ["canaries/typed-overrides.wgsl", { GAIN: "2.0", WG_X: "4u", ENABLED: "true" }],
  ["apps/docs/examples/fft-ocean-surface/ocean-surface.wgsl", { GRID: "512u" }],
]);

const posix = (path) => path.replaceAll("\\", "/");
const repoRelative = (path) => posix(relative(repoRoot, path));
const matchCount = (source, expression) => [...source.matchAll(expression)].length;

function withoutComments(source) {
  let output = "";
  let blockDepth = 0;
  let lineComment = false;
  let quote = null;
  let escaped = false;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    const next = source[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        output += character;
      } else output += " ";
    } else if (blockDepth > 0) {
      if (character === "/" && next === "*") {
        blockDepth++;
        output += "  ";
        index++;
      } else if (character === "*" && next === "/") {
        blockDepth--;
        output += "  ";
        index++;
      } else output += character === "\n" ? "\n" : " ";
    } else if (quote) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
      output += character;
    } else if (character === "/" && next === "/") {
      lineComment = true;
      output += "  ";
      index++;
    } else if (character === "/" && next === "*") {
      blockDepth = 1;
      output += "  ";
      index++;
    } else output += character;
  }
  return output;
}

function bakeOverrides(source, selected, label) {
  const overrides = [];
  const output = source.replace(
    /(?:@id\s*\([^)]*\)\s*)?override\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=;]+?))?\s*(?:=\s*([^;]+?))?\s*;/g,
    (_declaration, name, type, defaultValue) => {
      const value = selected[name] ?? defaultValue?.trim();
      if (!value) throw new Error(`${label}: override ${name} has no selected or default value`);
      overrides.push({ name, type: type?.trim() ?? null, selectedValue: value });
      return `const ${name}${type ? `: ${type.trim()}` : ""} = ${value};`;
    },
  );
  for (const name of Object.keys(selected)) {
    if (!overrides.some((entry) => entry.name === name)) {
      throw new Error(`${label}: selected override ${name} was not declared`);
    }
  }
  if (/\boverride\s+[A-Za-z_]/.test(withoutComments(output))) {
    throw new Error(`${label}: an override declaration remains after baking`);
  }
  return { output, overrides };
}

function fallbackReflection(source, error) {
  return {
    bindings: [],
    entryPoints: [...source.matchAll(/@(vertex|fragment|compute)\b[\s\S]*?\bfn\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)].map((match) => ({
      stage: match[1],
      name: match[2],
      mangledName: match[2],
      bindings: [],
      samplingPairs: [],
    })),
    overrides: [],
    reflectionError: { name: error?.name, code: error?.code, message: error?.message ?? String(error) },
  };
}

const inputs = [];
const bakedOverrides = [];
async function prepareInput({ kind, name, logicalPath, source, contract, tint, naga, reason }) {
  const selected = overrideSelections.get(logicalPath) ?? {};
  const baked = bakeOverrides(source, selected, logicalPath);
  const output = join(preparedDir, kind, logicalPath);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, baked.output);
  if (baked.overrides.length) bakedOverrides.push({ name, overrides: baked.overrides });

  let reflection;
  try {
    reflection = reflectSource(baked.output, logicalPath);
  } catch (error) {
    if (contract !== "invalid") throw error;
    reflection = fallbackReflection(baked.output, error);
  }
  const reflectionPath = `${output}.reflection.json`;
  await writeFile(reflectionPath, `${JSON.stringify(reflection, null, 2)}\n`);
  inputs.push({
    kind,
    name,
    logicalPath,
    input: repoRelative(output),
    reflection: repoRelative(reflectionPath),
    contract,
    expectations: { tint, naga },
    reason,
    entryPoints: reflection.entryPoints.length,
  });
}

for (const canary of canaries) {
  const logicalPath = `canaries/${canary.name}.wgsl`;
  await prepareInput({
    ...canary,
    kind: "canary",
    logicalPath,
    source: await readFile(join(fixtureDir, logicalPath), "utf8"),
  });
}

let inventory = null;
let resolution = null;
if (mode === "full") {
  const fixtureRelative = repoRelative(fixtureDir);
  const paths = execFileSync(
    "rg",
    ["--files", "-g", "*.wgsl", "-g", `!${fixtureRelative}/**`],
    { cwd: repoRoot, encoding: "utf8" },
  ).trim().split("\n").filter(Boolean).sort();

  const records = [];
  for (const path of paths) {
    const source = await readFile(join(repoRoot, path), "utf8");
    const code = withoutComments(source);
    const vertex = matchCount(code, /@vertex\b/g);
    const fragment = matchCount(code, /@fragment\b/g);
    const compute = matchCount(code, /@compute\b/g);
    const role = compute
      ? vertex || fragment ? "mixed-render-compute" : "compute"
      : vertex && fragment ? "draw-render"
      : vertex ? "vertex-only-render"
      : fragment ? "fragment-only-effect-like"
      : "library";
    records.push({
      path,
      bytes: Buffer.byteLength(source),
      lines: source.split("\n").length,
      role,
      entryPoints: vertex + fragment + compute,
      imports: matchCount(code, /^\s*import[\s\S]*?\sfrom\s+["'][^"']+["']\s*;/gm),
      exports: matchCount(code, /^\s*export\b/gm),
      bindings: matchCount(code, /@binding\s*\(/g),
      overrides: matchCount(code, /\boverride\s+[A-Za-z_]/g),
      f16: /\bf16\b|\bvec\d+h\b|\bmat\d+x\d+h\b|^\s*enable\s+f16\b/m.test(code),
    });
  }
  const sum = (select) => records.reduce((total, record) => total + select(record), 0);
  const roleNames = [...new Set(records.map((record) => record.role))].sort();
  inventory = {
    files: records.length,
    bytes: sum((record) => record.bytes),
    lines: sum((record) => record.lines),
    filesWithEntrypoints: records.filter((record) => record.entryPoints > 0).length,
    entryPoints: sum((record) => record.entryPoints),
    filesWithImports: records.filter((record) => record.imports > 0).length,
    importStatements: sum((record) => record.imports),
    filesWithExports: records.filter((record) => record.exports > 0).length,
    bindingDeclarations: sum((record) => record.bindings),
    overrideDeclarations: sum((record) => record.overrides),
    f16Files: records.filter((record) => record.f16).length,
    roles: Object.fromEntries(roleNames.map((role) => [role, records.filter((record) => record.role === role).length])),
  };

  const { resolveShader } = await import(
    pathToFileURL(join(repoRoot, "packages/wgsl/dist/runtime/resolve-shader.js")).href
  );
  const failures = [];
  let deterministic = 0;
  for (const [index, path] of paths.entries()) {
    try {
      const first = await resolveShader({ entry: join(repoRoot, path), validate: false, minify: false });
      const second = await resolveShader({ entry: join(repoRoot, path), validate: false, minify: false });
      if (first.wgsl !== second.wgsl) throw new Error(`${path}: resolver output is not deterministic`);
      deterministic++;
      const contract = path === translatorNegative ? "invalid" : "valid";
      await prepareInput({
        kind: "corpus",
        name: path,
        logicalPath: path,
        source: first.wgsl,
        contract,
        tint: contract === "invalid" ? "failure" : "success",
        naga: contract === "invalid" || nagaExtensionFailures.has(path) ? "failure" : "success",
        reason: nagaExtensionFailures.has(path) ? "unrestricted_pointer_parameters is unsupported by Naga 30.0.1" : undefined,
      });
    } catch (error) {
      const code = error?.code ?? error?.name ?? "unknown";
      const expectedCode = resolverNegatives.get(path);
      failures.push({ path, code, expected: code === expectedCode });
    }
    if ((index + 1) % 50 === 0) console.error(`prepared ${index + 1}/${paths.length}`);
  }
  const unexpected = failures.filter((failure) => !failure.expected);
  const missingExpected = [...resolverNegatives.keys()].filter((path) => !failures.some((failure) => failure.path === path));
  if (unexpected.length || missingExpected.length) {
    throw new Error(`resolver outcome drift: ${JSON.stringify({ unexpected, missingExpected })}`);
  }
  resolution = {
    attempted: paths.length,
    succeeded: paths.length - failures.length,
    deterministic,
    failures,
  };
}

const manifest = {
  schemaVersion: 1,
  mode,
  inventory,
  resolution,
  overrides: bakedOverrides,
  inputs,
};
await writeFile(join(artifactsDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({
  mode,
  canaries: inputs.filter((input) => input.kind === "canary").length,
  corpus: inputs.filter((input) => input.kind === "corpus").length,
  inventory,
  resolution,
  overrides: bakedOverrides,
}, null, 2));
