import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkPrRelease, gitDataReader } from "./lib/pr-release.mjs";
import { parsePrType } from "./lib/migrations.mjs";
import { RELEASE_PACKAGES } from "./lib/release-packages.mjs";
import { finalizeMigration, syncMigration } from "./migrations.mjs";

const temps: string[] = [];
afterEach(() => { for (const root of temps.splice(0)) rmSync(root, { recursive: true, force: true }); });
const body = (type: string) => `## PR type\n\n${type}\n\n## Release impact\n\nnone — Changes already accounted for in their original PRs.\n\n## Migration review\n\nFrom 0.4.1: no adaptation for optional exports. Covers optional-api; typecheck and consumer tests passed.\n`;
const reader = (data: Record<string, string>) => ({ paths: Object.keys(data), read: (path: string) => data[path] });
function fixture(finalized = true) {
  const root = mkdtempSync(join(tmpdir(), "vgpu-pr-policy-test-"));
  temps.push(root);
  mkdirSync(join(root, ".changeset"));
  const before: Record<string, string> = {};
  for (const { name, directory } of RELEASE_PACKAGES) {
    mkdirSync(join(root, directory), { recursive: true });
    const manifest = { name, version: "0.4.1", private: false, publishConfig: { access: "public" }, repository: { type: "git", url: "git+https://github.com/vercel-labs/vgpu.git", directory } };
    before[`${directory}/package.json`] = JSON.stringify(manifest);
    writeFileSync(join(root, directory, "package.json"), JSON.stringify({ ...manifest, version: "0.5.0-rc.0" }));
  }
  writeFileSync(join(root, ".changeset/config.json"), JSON.stringify({ fixed: [RELEASE_PACKAGES.map(item => item.name)] }));
  const sources = { "optional-api": '---\n"vgpu": minor\n---\n\n## Summary\n\nAdds optional exports.\n\n## Migration\n\nNone: existing calls and defaults are unchanged.\n' };
  writeFileSync(join(root, ".changeset/optional-api.md"), sources["optional-api"]);
  syncMigration(root, "0.5.0-rc.0", sources);
  if (finalized) {
    writeFileSync(join(root, "docs/migrations/0.5.0.docs.md"), "---\ntitle: Migrating to 0.5.0\n---\n\n# Migrating to 0.5.0\n\n## From the previous stable release\n\nFrom 0.4.1: existing calls and defaults are unchanged.\n\n## From release candidates\n\nThere are no earlier published RCs in this cycle.\n\n## Verification\n\nTypecheck the application and exercise existing exports.\n");
    finalizeMigration(root);
  }
  const data = Object.fromEntries(readdirSync(root, { recursive: true, encoding: "utf8" }).filter(path => statSync(join(root, path)).isFile()).map(path => [path, readFileSync(join(root, path), "utf8")]));
  const changedFiles = RELEASE_PACKAGES.map(item => ({ status: "M", path: `${item.directory}/package.json` }));
  return { root, data, before, input: { body: body("release"), baseBranch: "canary", changedFiles, base: reader(before), head: reader(data) } };
}

describe("explicit PR type", () => {
  it.each(["development", "release"])("accepts %s, ignoring template comments", type => {
    expect(parsePrType(`<!-- ## PR type\nrelease -->\n${body(type)}`)).toBe(type);
  });
  it.each(["", "## PR type\n", body("Release"), body("development or release"), body("development") + "\n## PR type\nrelease", "```md\n## PR type\nrelease\n```"])("rejects absent, ambiguous and fenced-only declarations", text => {
    expect(() => parsePrType(text)).toThrow();
  });
  it("keeps PR type independent of release impact", () => {
    const { input, before } = fixture();
    expect(checkPrRelease({ ...input, body: body("development"), changedFiles: [], head: reader(before) }).type).toBe("development");
  });
  it("rejects public version bumps disguised as development, including private toggles", () => {
    const { input, data } = fixture();
    expect(() => checkPrRelease({ ...input, body: body("development") })).toThrow("Declare PR type release");
    data["packages/vgpu-api/package.json"] = JSON.stringify({ name: "vgpu", version: "0.5.0-rc.0", private: true });
    expect(() => checkPrRelease({ ...input, body: body("development") })).toThrow("Declare PR type release");
  });
  it("does not classify private tooling versions or new package creation as release preparation", () => {
    const path = "apps/tool/package.json";
    const input = { body: body("development"), baseBranch: "canary", changedFiles: [{ status: "M", path }], base: reader({ [path]: '{"private":true,"version":"1.0.0"}' }), head: reader({ [path]: '{"private":true,"version":"2.0.0"}' }) };
    expect(checkPrRelease(input).type).toBe("development");
    expect(checkPrRelease({ ...input, base: reader({}), head: reader({ [path]: '{"private":false,"version":"0.1.0"}' }) }).type).toBe("development");
  });
  it("keeps main promotions separate and permits versions already accounted for on target", () => {
    const { input } = fixture();
    expect(checkPrRelease({ ...input, body: body("development"), baseBranch: "main" }).type).toBe("development");
    expect(checkPrRelease({ ...input, body: body("development"), target: input.head }).type).toBe("development");
    expect(() => checkPrRelease({ ...input, baseBranch: "main" })).toThrow("must target canary");
  });
});

describe("release PR readiness before merge", () => {
  it("allows an explicitly activated native companion only through full release preparation", () => {
    const { input, data, before } = fixture();
    const nativePath = "packages/native/package.json";
    before[nativePath] = JSON.stringify({ name: "@vgpu/native", version: "0.0.0", private: true });
    data[nativePath] = JSON.stringify({
      name: "@vgpu/native", version: "0.5.0-rc.0", private: false,
      repository: { type: "git", url: "git+https://github.com/vercel-labs/vgpu.git", directory: "packages/native" },
      publishConfig: { access: "public" },
    });
    data[".changeset/config.json"] = JSON.stringify({ fixed: [[...RELEASE_PACKAGES.map(item => item.name), "@vgpu/native"]] });
    const activation = { ...input, head: reader(data), changedFiles: [...input.changedFiles, { status: "M", path: nativePath }] };
    expect(checkPrRelease(activation)).toMatchObject({ type: "release", version: "0.5.0-rc.0" });
    expect(() => checkPrRelease({ ...activation, body: body("development") })).toThrow("Declare PR type release");
    data["docs/migrations/0.5.0.docs.md"] += "\nChanged guide after review.\n";
    expect(() => checkPrRelease(activation)).toThrow("review drift");
  });
  it("accepts a fully prepared release using the publication migration checks", () => {
    const { input } = fixture();
    expect(checkPrRelease(input)).toMatchObject({ type: "release", version: "0.5.0-rc.0" });
  });
  it("rejects missing or placeholder editorial evidence", () => {
    const { input } = fixture();
    expect(() => checkPrRelease({ ...input, body: body("release").split("## Migration review")[0] })).toThrow("Migration review");
    expect(() => checkPrRelease({ ...input, body: body("release").split("## Migration review")[0] + "## Migration review\nTODO" })).toThrow("placeholders");
  });
  it("rejects a development PR mislabeled as release", () => {
    const { input, before } = fixture();
    expect(() => checkPrRelease({ ...input, changedFiles: [], head: reader(before) })).toThrow("new vgpu version");
  });
  it("rejects a release behind the current canary version", () => {
    const { input, before } = fixture();
    before["packages/vgpu-api/package.json"] = JSON.stringify({ version: "0.5.0-rc.1" });
    expect(() => checkPrRelease(input)).toThrow("must advance");
  });
  it("rejects inconsistent package versions and unexpected public packages", () => {
    const { input, data } = fixture();
    const original = data["packages/core/package.json"];
    data["packages/core/package.json"] = original.replace("0.5.0-rc.0", "0.4.1");
    expect(() => checkPrRelease(input)).toThrow("expected 0.5.0-rc.0");
    data["packages/core/package.json"] = original;
    data["apps/unexpected/package.json"] = '{"name":"unexpected","version":"1.0.0"}';
    expect(() => checkPrRelease({ ...input, head: reader(data) })).toThrow("missing from the release allowlist");
  });
  it("rejects draft guides before a release PR can merge", () => {
    expect(() => checkPrRelease(fixture(false).input)).toThrow("Editorial migration review required");
  });
  it("rejects stale guide reviews and uncollected sources", () => {
    const { input, data } = fixture();
    const path = "docs/migrations/0.5.0.docs.md";
    const original = data[path];
    data[path] += "\nChanged after review.\n";
    expect(() => checkPrRelease(input)).toThrow("review drift");
    data[path] = original;
    data[".changeset/optional-api.md"] += "\nUpdated justification.\n";
    expect(() => checkPrRelease(input)).toThrow("not collected");
  });
  it("rejects malformed migration filenames instead of dropping them from validation", () => {
    const { input, data } = fixture();
    data[".changeset/Invalid.md"] = data[".changeset/optional-api.md"];
    expect(() => checkPrRelease({ ...input, head: reader(data) })).toThrow("Invalid migration data path");
  });
  it("reads real Git blobs without following symlinks or executing candidate code", () => {
    const { root, input } = fixture();
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/migrations.mjs"), 'throw new Error("Candidate code must never run");');
    symlinkSync("../../outside.json", join(root, ".changeset/linked.json"));
    git("init", "--initial-branch=canary");
    git("add", ".");
    const tree = git("write-tree").trim();
    const head = gitDataReader(git, tree);
    expect(checkPrRelease({ ...input, head }).type).toBe("release");
    expect(() => head.read(".changeset/linked.json")).toThrow("regular Git blob");
    expect(head.read("missing.json")).toBeUndefined();
  });
});
