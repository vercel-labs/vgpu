import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { build } from "esbuild";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  BUDGET_NOTE,
  EXPORT_BUDGET_FIELD,
  EXPORT_NOTE_FIELD,
  PACKAGE_BUDGET_FIELD,
  PACKAGE_NOTE_FIELD,
  evaluateBudget,
  exportBudgetField,
  exportLabel,
  formatFailure,
  formatVerdictLine,
  measuredTarballPayload,
  nextBudgetBytes,
  parseTarEntries,
  prohibitedExperienceInputs,
  retainedMetafileInputs,
  resolveExportAudience,
  resolvePackageAudience,
  resolveThreshold,
} from "./lib/bundle-budgets.mjs";

const options = parseArgs(process.argv.slice(2));
const root = process.cwd();
const packagesDir = join(root, "packages");
const failures = [];
const warnings = [];
const updates = [];
const structuralFailures = [];

// These fixtures target the public gpu-first API introduced by T202-05. They are deliberately
// opt-in while that cut and the versioned manifest ceilings are absent, so regular CI stays green.
const EXPERIENCE_BUDGET_FIELD = "vgpuExperienceBundleBudgetsGzipBytes";
const EXPERIENCE_FIXTURES = [
  { name: "init-only", fixture: "init-only.ts" },
  { name: "effect-only", fixture: "effect-only.ts" },
  { name: "triangle-low-level", fixture: "triangle-low-level.ts" },
  { name: "draw-recipe-box", fixture: "draw-recipe-box.ts" },
  // #205 owns this public API; do not substitute an internal vgpu/scene import to make it measure.
  { name: "scene-renderer", fixture: "scene-renderer.ts", deferred: "#205 has not published createSceneView yet" },
  { name: "full-root", fixture: "full-root.ts" },
];

for (const name of (await readdir(packagesDir)).sort()) {
  const dir = join(packagesDir, name);
  const manifestPath = join(dir, "package.json");
  const pkg = JSON.parse(await readFile(manifestPath, "utf8"));
  if (pkg[EXPORT_BUDGET_FIELD]) await checkExportBudgets(dir, manifestPath, pkg);
  else if (pkg[PACKAGE_BUDGET_FIELD]) await checkPackageBudget(dir, manifestPath, pkg);
  if (options.experiences && pkg.name === "vgpu") await checkExperienceBudgets(dir, manifestPath, pkg);
}

report();

async function checkExportBudgets(dir, manifestPath, pkg) {
  const threshold = resolveThreshold(pkg, options.threshold);
  const measured = {};
  for (const [subpath, budget] of Object.entries(pkg[EXPORT_BUDGET_FIELD])) {
    const exportInfo = pkg.exports?.[subpath];
    const jsFile = typeof exportInfo === "object" ? exportInfo.import : exportInfo;
    const path = join(dir, jsFile.replace(/^\.\//, ""));
    const gzipBytes = existsSync(path) ? await bundledGzipSize(path) : Infinity;
    measured[subpath] = gzipBytes;
    record({
      label: exportLabel(pkg.name, subpath),
      field: exportBudgetField(subpath),
      manifestPath: relative(root, manifestPath),
      verdict: evaluateBudget({ measuredBytes: gzipBytes, budgetBytes: budget, audience: resolveExportAudience(pkg, subpath), threshold }),
    });
  }
  if (options.update) {
    updateManifest(manifestPath, pkg, (draft) => {
      for (const [subpath, gzipBytes] of Object.entries(measured)) {
        if (!Number.isFinite(gzipBytes)) throw new Error(`${exportLabel(pkg.name, subpath)}: cannot update the budget, the built artifact is missing (run \`pnpm build\` first)`);
        draft[EXPORT_BUDGET_FIELD][subpath] = nextBudgetBytes(gzipBytes);
      }
      draft[EXPORT_NOTE_FIELD] = BUDGET_NOTE;
    });
  }
}

async function checkExperienceBudgets(dir, manifestPath, pkg) {
  const budgets = pkg[EXPERIENCE_BUDGET_FIELD];
  if (!budgets) {
    throw new Error(
      `Experience budgets are scaffolded but not activated: ${relative(root, manifestPath)} must declare ${EXPERIENCE_BUDGET_FIELD} after T202-05. ` +
        "Until then --experiences is expected to fail because its fixtures intentionally import the new gpu-first public API.",
    );
  }

  const measurements = [];
  for (const experience of EXPERIENCE_FIXTURES) {
    if (experience.deferred) {
      console.log(`${experience.name}: deferred (${experience.deferred})`);
      continue;
    }
    const budget = budgets[experience.name];
    if (typeof budget !== "number") throw new Error(`${relative(root, manifestPath)}: missing ${EXPERIENCE_BUDGET_FIELD}[${JSON.stringify(experience.name)}]`);
    const entryPoint = join(dir, "tests", "bundle-fixtures", experience.fixture);
    const result = await build({
      entryPoints: [entryPoint], bundle: true, format: "esm", platform: "neutral",
      external: ["node:*", "webgpu", "@vgpu/*"], write: false, minify: true, metafile: true,
      mainFields: ["module", "main"],
    });
    const contents = result.outputFiles[0].contents;
    const output = Object.values(result.metafile.outputs)[0];
    if (!output) throw new Error(`esbuild returned no metafile output for experience ${experience.name}`);
    const inputs = retainedMetafileInputs(output).map((input) => relative(root, input).replaceAll("\\", "/")).sort();
    measurements.push({ experience, budget, rawBytes: contents.length, gzipBytes: gzipSync(contents).length, inputs });
  }

  const baseline = measurements.find((measurement) => measurement.experience.name === "full-root")?.gzipBytes;
  for (const measurement of measurements) {
    const delta = baseline === undefined ? "n/a" : `${measurement.gzipBytes - baseline >= 0 ? "+" : ""}${measurement.gzipBytes - baseline} B vs full-root`;
    console.log(`${measurement.experience.name}: ${measurement.rawBytes} B raw / ${measurement.gzipBytes} B gzip / ${measurement.inputs.length} inputs / ${delta}`);
    for (const input of measurement.inputs) console.log(`  input: ${input}`);
    record({
      label: `vgpu experience ${measurement.experience.name}`,
      field: `${EXPERIENCE_BUDGET_FIELD}[${JSON.stringify(measurement.experience.name)}]`,
      manifestPath: relative(root, manifestPath),
      verdict: evaluateBudget({ measuredBytes: measurement.gzipBytes, budgetBytes: measurement.budget, audience: "client" }),
    });
    for (const retained of prohibitedExperienceInputs(measurement.experience.name, measurement.inputs)) {
      structuralFailures.push(`vgpu experience ${measurement.experience.name}: retained prohibited ${retained.category} input ${retained.input}`);
    }
  }
}

async function bundledGzipSize(entryPoint) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    platform: "neutral",
    external: ["node:*", "webgpu", "@vgpu/*"],
    write: false,
    minify: true,
    mainFields: ["module", "main"],
  });
  return gzipSync(result.outputFiles[0].contents).length;
}

async function checkPackageBudget(dir, manifestPath, pkg) {
  const bytes = packedDistGzipSize(dir, pkg);
  record({
    label: pkg.name,
    field: PACKAGE_BUDGET_FIELD,
    manifestPath: relative(root, manifestPath),
    verdict: evaluateBudget({ measuredBytes: bytes, budgetBytes: pkg[PACKAGE_BUDGET_FIELD], audience: resolvePackageAudience(pkg), threshold: resolveThreshold(pkg, options.threshold) }),
  });
  if (options.update) {
    updateManifest(manifestPath, pkg, (draft) => {
      draft[PACKAGE_BUDGET_FIELD] = nextBudgetBytes(bytes);
      draft[PACKAGE_NOTE_FIELD] = BUDGET_NOTE;
    });
  }
}

/**
 * Gzip size of the published dist bytes: `pnpm pack` decides the file set, then `*.docs.md` files
 * are dropped and sourcemap `sourcesContent` stripped before gzipping (issue #200 C), so docs and
 * inlined sources never compete with the size gate.
 */
function packedDistGzipSize(dir, pkg) {
  execFileSync("pnpm", ["--dir", dir, "pack", "--pack-destination", dir], { stdio: "ignore" });
  const tarball = join(dir, `${pkg.name.replace("@", "").replace("/", "-")}-${pkg.version}.tgz`);
  try {
    const entries = parseTarEntries(gunzipSync(readFileSync(tarball)));
    return gzipSync(measuredTarballPayload(entries)).length;
  } finally {
    rmSync(tarball, { force: true });
  }
}

function record(entry) {
  console.log(formatVerdictLine(entry.label, entry.verdict));
  if (entry.verdict.status === "fail") failures.push(entry);
  if (entry.verdict.status === "warn") warnings.push(entry);
}

function updateManifest(manifestPath, pkg, mutate) {
  const draft = JSON.parse(JSON.stringify(pkg));
  mutate(draft);
  const next = `${JSON.stringify(draft, null, 2)}\n`;
  const previous = readFileSync(manifestPath, "utf8");
  if (next === previous) return;
  writeFileSync(manifestPath, next);
  updates.push(relative(root, manifestPath));
}

function report() {
  if (options.update) {
    console.log(updates.length ? `\nUpdated budgets in:\n${updates.map((path) => `  ${path}`).join("\n")}` : "\nBudgets already match the convention, nothing to update.");
    return;
  }
  if (warnings.length) {
    console.log(`\n${warnings.length} tooling budget${warnings.length === 1 ? "" : "s"} exceeded within the growth threshold (warning only):`);
    for (const warning of warnings) console.log(`  ${warning.label}: ${warning.verdict.measuredBytes} B gzip vs ${warning.verdict.budgetBytes} B budget (+${warning.verdict.overBudgetBytes} B) -> re-baseline with \`pnpm bundle-check --update\``);
  }
  if (!failures.length && !structuralFailures.length) return;
  if (structuralFailures.length) console.error(`\n${structuralFailures.length} experience metafile assertion${structuralFailures.length === 1 ? "" : "s"} failed:\n${structuralFailures.map((failure) => `  ${failure}`).join("\n")}\n`);
  if (failures.length) console.error(`\n${failures.length} bundle budget${failures.length === 1 ? "" : "s"} exceeded:\n`);
  for (const failure of failures) console.error(`${formatFailure(failure)}\n`);
  if (failures.length) console.error("Run `pnpm bundle-check --update` to re-baseline every budget to the convention (next 512 B multiple strictly above measured), then review the one-line diffs.");
  process.exit(1);
}

function parseArgs(argv) {
  const parsed = { update: false, threshold: undefined, experiences: false };
  for (const arg of argv) {
    if (arg === "--update") parsed.update = true;
    else if (arg === "--experiences") parsed.experiences = true;
    else if (arg.startsWith("--threshold=")) parsed.threshold = parseThreshold(arg.slice("--threshold=".length));
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: pnpm bundle-check [--update] [--experiences] [--threshold=<fraction|percent%>]\n\n  --experiences        measure opt-in T202-06 consumer fixtures and assert metafile exclusions (requires post-T202-05 manifest ceilings)\n  --update             rewrite every budget to the convention (next 512 B multiple strictly above measured)\n  --threshold=0.05     override the tooling growth threshold (accepts 0.05 or 5%)");
      process.exit(0);
    } else {
      console.error(`Unknown argument ${arg}. Usage: pnpm bundle-check [--update] [--experiences] [--threshold=<fraction|percent%>]`);
      process.exit(2);
    }
  }
  return parsed;
}

function parseThreshold(raw) {
  const value = raw.endsWith("%") ? Number(raw.slice(0, -1)) / 100 : Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    console.error(`Invalid --threshold=${raw}: expected a non-negative fraction (0.05) or percentage (5%).`);
    process.exit(2);
  }
  return value;
}
