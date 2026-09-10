import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkImpact, parsePrType, stableVersion, validateMigrationReview } from "./migrations.mjs";
import { checkMigrations } from "../migrations.mjs";
import { validateReleasePackages } from "./release-packages.mjs";

// Readers return Git blob text or undefined for missing paths. Never load candidate modules.
export function checkPrRelease({ body, baseBranch, changedFiles, base, head, target = base }) {
  const type = parsePrType(body);
  const impact = checkImpact(body, changedFiles, path => head.read(path));
  const manifests = head.paths.filter(path => /^(packages|apps|examples)\/[^/]+\/package\.json$/u.test(path));
  const versionChanges = changedFiles.filter(file => /^(packages|apps|examples)\/[^/]+\/package\.json$/u.test(file.path)).filter(file => {
    const before = base.read(file.path);
    const after = head.read(file.path);
    if (!before || !after) return false; // New/removed packages are development, not version preparation.
    const previous = JSON.parse(before);
    const next = JSON.parse(after);
    // Include packages made private in this PR: changing private must not hide a version bump.
    if (previous.private === true && next.private === true) return false;
    const current = target.read(file.path);
    return previous.version !== next.version && (!current || JSON.parse(current).version !== next.version);
  });
  if (type === "development") {
    // Main promotions have their own main-policy; synchronization may carry versions already on target.
    if (baseBranch === "canary" && versionChanges.length) throw new Error(`Public package versions changed: ${versionChanges.map(file => file.path).join(", ")}. Declare PR type release and complete release preparation.`);
    return { type, impact };
  }
  if (baseBranch !== "canary") throw new Error("PR type release is release preparation and must target canary. Promotions to main use development and main-policy.");
  validateMigrationReview(body);
  const version = JSON.parse(head.read("packages/vgpu-api/package.json")).version;
  stableVersion(version);
  if (!versionChanges.some(file => file.path === "packages/vgpu-api/package.json")) throw new Error("A release PR must prepare a new vgpu version; ordinary changes or synchronization use development.");
  const previousVersion = JSON.parse(target.read("packages/vgpu-api/package.json")).version;
  const parts = value => {
    const stable = stableVersion(value).split(".").map(BigInt);
    return [...stable, value.includes("-rc.") ? 0n : 1n, BigInt(value.split("-rc.")[1] ?? "0")];
  };
  const previousParts = parts(previousVersion);
  const nextParts = parts(version);
  const firstDifference = nextParts.findIndex((part, index) => part !== previousParts[index]);
  if (firstDifference < 0 || nextParts[firstDifference] < previousParts[firstDifference]) throw new Error(`Release version ${version} must advance the current canary version ${previousVersion}.`);
  const errors = validateReleasePackages({
    configuredFixedPackageNames: JSON.parse(head.read(".changeset/config.json")).fixed.flat(),
    manifests: manifests.map(manifestPath => ({ manifestPath, manifest: JSON.parse(head.read(manifestPath)) })),
    expectedVersion: version,
  });
  if (errors.length) throw new Error(`Release package validation failed: ${errors.join(", ")}`);

  // Materialize only allowlisted DATA into a fresh directory for the SAME check used at publication.
  // No candidate scripts/config execution, package install, symlinks or arbitrary output paths.
  const inputPaths = head.paths.filter(path =>
    /^\.changeset\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/u.test(path) || path === ".changeset/pre.json" ||
    /^docs\/migrations\/(?:records\/[0-9]+\.[0-9]+\.[0-9]+\.json|(?:index|[0-9]+\.[0-9]+\.[0-9]+)\.docs\.md)$/u.test(path)
  );
  // Do not silently ignore malformed names that the regular migrations checker would reject.
  for (const path of head.paths) {
    if ((/^\.changeset\/[^/]+\.md$/u.test(path) && path !== ".changeset/README.md") || /^docs\/migrations\/[^/]+\.docs\.md$/u.test(path) || /^docs\/migrations\/records\/[^/]+\.json$/u.test(path)) {
      if (!inputPaths.includes(path)) throw new Error(`Invalid migration data path: ${path}`);
    }
  }
  inputPaths.push("packages/vgpu-api/package.json");
  const root = mkdtempSync(join(tmpdir(), "vgpu-pr-release-"));
  try {
    mkdirSync(join(root, ".changeset"));
    for (const path of inputPaths) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), head.read(path));
    }
    checkMigrations(root, { release: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  return { type, impact, version };
}

export function gitDataReader(git, revision) {
  const entries = new Map(git("ls-tree", "-r", "-z", revision).split("\0").filter(Boolean).map(entry => {
    const separator = entry.indexOf("\t");
    return [entry.slice(separator + 1), entry.slice(0, separator).split(" ")];
  }));
  return {
    paths: [...entries.keys()],
    read(path) {
      const entry = entries.get(path);
      if (!entry) return undefined;
      if (!["100644", "100755"].includes(entry[0]) || entry[1] !== "blob") throw new Error(`Expected regular Git blob: ${path}`);
      return git("cat-file", "blob", entry[2]);
    },
  };
}
