import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkImpact, parseChangeset, parseImpact, parseNotes, renderMigrationDraft, stableVersion, validateMigrationGuide } from "./lib/migrations.mjs";
import { checkMigrations, finalizeMigration, reviewInputs, syncMigration } from "./migrations.mjs";

const noMigration = "## Summary\n\nAdds an optional API.\n\n## Migration\n\nNone: existing calls and defaults are unchanged.\n";
const required = "## Summary\n\nRemoves resize.\n\n## Migration\n\n### Affected usage\n\nConsumers of Texture.resize on 0.4.x.\n\n### Steps\n\nCreate and rebind a replacement texture.\n\n#### Before\n\n```ts illustrative\ntexture.resize(size);\n```\n\n#### After\n\nAllocate a replacement and rebind it.\n\n### Verification\n\nResize the application and verify its rendered output.\n";
const source = (body = noMigration) => `---\n"vgpu": patch\n---\n\n${body}`;
const temps: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "vgpu-migrations-test-"));
  temps.push(root);
  mkdirSync(join(root, ".changeset"));
  mkdirSync(join(root, "packages/vgpu-api"), { recursive: true });
  writeFileSync(join(root, "packages/vgpu-api/package.json"), JSON.stringify({ version: "0.5.0-rc.0" }));
  return root;
}

function editGuide(root: string, stable = "Create and rebind a replacement texture.", rc = "No earlier RC requires additional migration; the texture contract is unchanged.") {
  const guide = renderMigrationDraft("0.5.0")
    .replace("TODO: Read all cycle changesets and write the net migration in dependency order.", stable)
    .replace("TODO: Describe the path from each affected published RC, including reversals.", rc)
    .replace("TODO: Explain how to verify the final API and behavior.", "Typecheck the project and verify replacement textures are rebound after resizing.");
  writeFileSync(join(root, "docs/migrations/0.5.0.docs.md"), guide);
  return guide;
}

function setVersion(root: string, version: string) {
  const path = join(root, "packages/vgpu-api/package.json");
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), version }));
}

describe("migration declarations", () => {
  it("accepts explicit none and required steps", () => {
    expect(parseChangeset(source(), "optional-export").required).toBe(false);
    expect(parseChangeset(source(required), "texture-resize").required).toBe(true);
  });
  it.each([
    "A legacy unstructured summary.",
    noMigration.replace("None: existing calls and defaults are unchanged.", "None:"),
    noMigration.replace("None: existing calls and defaults are unchanged.", "None: TODO decide"),
    required.replace("### Verification", "### Other"),
    required.replace("### Steps", "### Other"),
    required.replace("### Affected usage", "### Other"),
    required + "\n## Summary\nDuplicate.",
  ])("rejects an incomplete or ambiguous decision", body => {
    expect(() => parseChangeset(source(body), "test-change")).toThrow();
  });
  it("ignores headings inside fences, including longer fences", () => {
    const body = required.replace("Create and rebind a replacement texture.", "````md\n## Migration\n```ts\n### Steps\n```\n````\nActual steps.");
    expect(parseNotes(body).required).toBe(true);
  });
  it.each(["../escape", "A", "a/b"])("rejects unsafe IDs %s", id => expect(() => parseChangeset(source(), id)).toThrow());
  it("rejects unknown YAML keys and repeated packages", () => {
    expect(() => parseChangeset(source().replace('"vgpu": patch', 'migration: true'), "test")).toThrow();
    expect(() => parseChangeset(source().replace('"vgpu": patch', '"vgpu": patch\n"vgpu": minor'), "test")).toThrow();
  });
});

describe("PR release impact", () => {
  const files = [{ status: "A", path: ".changeset/new-api.md" }];
  it("requires no file for a justified no-impact PR", () => {
    expect(checkImpact("## Release impact\n\nnone — Only expands test coverage; runtime code is unchanged.\n\n## Validation\nTests pass.", [], () => "").kind).toBe("none");
  });
  it("ignores template comments and reads the actual declaration", () => {
    expect(parseImpact("## Release impact\n<!-- Instructions here -->\nnone — Only expands documentation examples.").kind).toBe("none");
  });
  it("validates exactly the new referenced files", () => {
    expect(checkImpact("## Release impact\nchangeset — `.changeset/new-api.md`", files, () => source()).kind).toBe("changeset");
  });
  it.each([
    "", "## Release impact\nnone", "## Release impact\nnone — TBD", "## Release impact\nchangeset — ../escape.md",
    "## Release impact\nnone — Tests only.\n## Release impact\nnone — More tests only.",
  ])("rejects missing/ambiguous/unsafe declarations", body => expect(() => parseImpact(body)).toThrow());
  it("rejects none when the PR adds changesets", () => expect(() => checkImpact("## Release impact\nnone — Only test coverage changes.", files, () => source())).toThrow());
  it("rejects unlisted or old changesets", () => {
    expect(() => checkImpact("## Release impact\nchangeset — .changeset/old-api.md", files, () => source())).toThrow();
    expect(() => checkImpact("## Release impact\nchangeset — .changeset/new-api.md", [{ status: "M", path: files[0].path }], () => source())).toThrow();
  });
});

describe("release collection", () => {
  it("upserts RC fragments by ID and retains them after stable consumption", () => {
    const root = fixture();
    const sources = { "texture-resize": source(required) };
    writeFileSync(join(root, ".changeset/texture-resize.md"), sources["texture-resize"]);
    syncMigration(root, "0.5.0-rc.0", sources);
    const first = editGuide(root);
    finalizeMigration(root);
    syncMigration(root, "0.5.0-rc.1", sources);
    expect(readFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "utf8")).toBe(first);
    syncMigration(root, "0.5.0", {});
    rmSync(join(root, ".changeset/texture-resize.md"));
    writeFileSync(join(root, "packages/vgpu-api/package.json"), JSON.stringify({ version: "0.5.0" }));
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
    expect(readFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "utf8")).toBe(first);
  });
  it("updates corrected fragments without duplicating them", () => {
    const root = fixture();
    syncMigration(root, "0.5.0-rc.0", { "texture-resize": source(required) });
    syncMigration(root, "0.5.0-rc.1", { "texture-resize": source(required.replace("Removes resize.", "Removes mutable resizing.")) });
    const record = JSON.parse(readFileSync(join(root, "docs/migrations/records/0.5.0.json"), "utf8"));
    expect(Object.keys(record.sources)).toEqual(["texture-resize"]);
    expect(record.sources["texture-resize"]).toContain("Removes mutable resizing.");
  });
  it("rejects lost RC IDs and additions to finalized stable records", () => {
    const root = fixture();
    writeFileSync(join(root, ".changeset/pre.json"), JSON.stringify({ mode: "pre", changesets: ["texture-resize"] }));
    expect(() => checkMigrations(root)).toThrow("removed or renamed");
    rmSync(join(root, ".changeset/pre.json"));
    syncMigration(root, "0.5.0", { "texture-resize": source(required) });
    setVersion(root, "0.5.0");
    editGuide(root);
    finalizeMigration(root);
    expect(() => syncMigration(root, "0.5.0", { "new-api": source() })).toThrow("finalized");
    expect(() => syncMigration(root, "0.5.0", {})).not.toThrow();
    editGuide(root, "Changed instructions after stable finalization.");
    expect(() => checkMigrations(root, { release: true })).toThrow("review drift");
    expect(() => finalizeMigration(root)).not.toThrow();
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
    setVersion(root, "0.6.0-rc.0");
    expect(() => finalizeMigration(root)).toThrow("Missing migration record");
  });
  it("blocks missing collection, direct-version bypass, uncollected changes and guide drift", () => {
    const root = fixture();
    expect(() => checkMigrations(root, { release: true })).toThrow("Missing migration record");
    syncMigration(root, "0.5.0-rc.0", {});
    writeFileSync(join(root, "packages/vgpu-api/package.json"), JSON.stringify({ version: "0.5.0-rc.1" }));
    expect(() => checkMigrations(root, { release: true })).toThrow("not 0.5.0-rc.1");
    syncMigration(root, "0.5.0-rc.1", {});
    writeFileSync(join(root, ".changeset/new-api.md"), source());
    expect(() => checkMigrations(root, { release: true })).toThrow("not collected");
    expect(() => finalizeMigration(root)).toThrow("not collected");
    syncMigration(root, "0.5.0-rc.1", { "new-api": source() });
    editGuide(root);
    finalizeMigration(root);
    writeFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "manually changed");
    expect(() => checkMigrations(root)).toThrow("drift");
  });
  it("requires editorial review even for no-migration releases and validates exact versions", () => {
    const root = fixture();
    syncMigration(root, "0.5.0-rc.0", { "new-api": source() });
    expect(() => checkMigrations(root)).not.toThrow(); // Drafts can be prepared, never published.
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    expect(() => finalizeMigration(root)).toThrow("placeholders");
    editGuide(root, "No migration is required: existing calls and defaults are unchanged.");
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
    expect(stableVersion("0.5.0-rc.2")).toBe("0.5.0");
    expect(() => stableVersion("0.5.0-beta.1")).toThrow();
  });
  it("requires review for each exact target, preserves prose, and is idempotent", () => {
    const root = fixture();
    const sources = { "new-api": source() };
    syncMigration(root, "0.5.0-rc.0", sources);
    const guide = editGuide(root);
    finalizeMigration(root);
    const recordPath = join(root, "docs/migrations/records/0.5.0.json");
    const reviewed = readFileSync(recordPath, "utf8");
    syncMigration(root, "0.5.0-rc.0", sources);
    finalizeMigration(root);
    expect(readFileSync(recordPath, "utf8")).toBe(reviewed);
    syncMigration(root, "0.5.0-rc.1", sources);
    setVersion(root, "0.5.0-rc.1");
    expect(readFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "utf8")).toBe(guide);
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    finalizeMigration(root);
    expect(JSON.parse(readFileSync(recordPath, "utf8")).review).not.toBe(JSON.parse(reviewed).review);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
  });
  it("invalidates source corrections, new fragments and guide edits", () => {
    const root = fixture();
    syncMigration(root, "0.5.0-rc.0", { "new-api": source() });
    editGuide(root);
    finalizeMigration(root);
    syncMigration(root, "0.5.0-rc.0", { "new-api": source(required) });
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    finalizeMigration(root);
    syncMigration(root, "0.5.0-rc.0", { "another-api": source() });
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    finalizeMigration(root);
    editGuide(root, "Updated net migration with consolidated texture instructions.");
    expect(() => checkMigrations(root, { release: true })).toThrow("review drift");
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
  });
  it("prints every archived source including None decisions after stable consumption", () => {
    const root = fixture();
    syncMigration(root, "0.5.0", { "texture-resize": source(required), "optional-api": source() });
    setVersion(root, "0.5.0");
    const inputs = reviewInputs(root);
    expect(inputs).toContain(source(required));
    expect(inputs).toContain(source());
    expect(inputs).toContain("docs/release-migrations.md");
    expect(inputs).toContain("Current guide");
    expect(inputs).toContain("published RC tags");
  });
  it("requires stable, RC and verification paths with substantive content", () => {
    const root = fixture();
    syncMigration(root, "0.5.0-rc.0", {});
    const guide = editGuide(root);
    expect(() => validateMigrationGuide(guide, "0.5.0")).not.toThrow();
    expect(() => validateMigrationGuide(guide.replace("## From release candidates", "## History"), "0.5.0")).toThrow("From release candidates");
    expect(() => validateMigrationGuide(guide, "0.6.0")).toThrow("title/frontmatter");
    expect(() => validateMigrationGuide(editGuide(root, "<!-- reviewed -->"), "0.5.0")).toThrow();
  });
  it("keeps migration prose out of the Changesets changelog renderer", async () => {
    vi.stubEnv("VGPU_RELEASE_VERSION", "0.5.0-rc.0");
    const require = createRequire(import.meta.url);
    const renderer = require("./changeset-changelog.cjs");
    const line = await renderer.getReleaseLine({ summary: required, commit: "abcdef123" }, "minor", {});
    expect(line).toContain("Removes resize.");
    expect(line).not.toContain("Affected usage");
    expect(line).toContain("/blob/v0.5.0-rc.0/docs/migrations/0.5.0.docs.md");
  });
  it("integrates with real Changesets across RC preparation and stable consumption", () => {
    const root = fixture();
    const require = createRequire(import.meta.url);
    const cli = join(require.resolve("@changesets/cli/package.json"), "..", "bin.js");
    let releaseVersion = "0.5.0-rc.0";
    const run = (...args: string[]) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", env: { ...process.env, VGPU_RELEASE_VERSION: releaseVersion } });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
    writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
    writeFileSync(join(root, "packages/vgpu-api/package.json"), JSON.stringify({ name: "vgpu", version: "0.4.1" }));
    writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({
      changelog: new URL("./changeset-changelog.cjs", import.meta.url).pathname,
      fixed: [["vgpu"]], linked: [], access: "public", baseBranch: "main", updateInternalDependencies: "patch", ignore: [],
    }));
    const changeset = source(required).replace('"vgpu": patch', '"vgpu": minor');
    writeFileSync(join(root, ".changeset/texture-resize.md"), changeset);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "--initial-branch=main");
    git("add", ".");
    git("-c", "user.name=Migration test", "-c", "user.email=migrations@example.test", "-c", "commit.gpgSign=false", "-c", "core.hooksPath=/dev/null", "commit", "-m", "Fixture");
    run("pre", "enter", "rc");
    const planPath = join(root, "plan.json");
    run("status", "--output", planPath);
    const plan = JSON.parse(readFileSync(planPath, "utf8"));
    expect(plan.releases.find((item: { name: string }) => item.name === "vgpu").newVersion).toBe("0.5.0-rc.0");
    run("version");
    syncMigration(root, "0.5.0-rc.0", { "texture-resize": changeset });
    editGuide(root);
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
    const changelog = readFileSync(join(root, "packages/vgpu-api/CHANGELOG.md"), "utf8");
    expect(changelog).toContain("Removes resize.");
    expect(changelog).not.toContain("Affected usage");

    // A later RC restores the old API: stable users must not remove then restore resize.
    const reversal = source(required.replace("Removes resize.", "Restores resize after RC feedback.").replace("Consumers of Texture.resize on 0.4.x.", "Consumers who adopted replacements in 0.5.0-rc.0.").replace("Create and rebind a replacement texture.", "Use resize again where appropriate in RC-adopter code."));
    writeFileSync(join(root, ".changeset/restore-resize.md"), reversal);
    releaseVersion = "0.5.0-rc.1";
    run("version");
    syncMigration(root, releaseVersion, { "texture-resize": changeset, "restore-resize": reversal });
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    const netGuide = editGuide(root,
      "From 0.4.x: keep using resize; the final API preserves the stable contract.",
      "From 0.5.0-rc.0: use resize again where appropriate. From rc.1: no additional adaptation is required.");
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();

    run("pre", "exit");
    releaseVersion = "0.5.0";
    run("version");
    syncMigration(root, "0.5.0", { "texture-resize": changeset, "restore-resize": reversal });
    expect(() => checkMigrations(root, { release: true })).toThrow("Editorial migration review required");
    finalizeMigration(root);
    expect(() => checkMigrations(root, { release: true })).not.toThrow();
    expect(readFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "utf8")).toBe(netGuide);
    expect(netGuide).not.toContain("Create and rebind");
  }, 20_000);
  it("uses a trusted edited-event workflow and keeps candidate code inert", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-impact.yml", import.meta.url), "utf8");
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("edited]");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("node .release-impact/trusted/scripts/check-release-impact.mjs");
    expect(workflow).not.toContain("pnpm install");
    expect(workflow).not.toContain("secrets.");
  });
});
