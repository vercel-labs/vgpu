import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
  RELEASE_PACKAGES,
  validateReleasePackages,
} from "./lib/release-packages.mjs";

const version = "0.5.0";

type TestManifest = {
  name: string;
  private: boolean;
  version: string;
  repository?: { type: string; url: string; directory: string };
  publishConfig?: { access: string };
};

function validInput(): {
  configuredFixedPackageNames: string[];
  expectedVersion: string;
  manifests: Array<{ manifestPath: string; manifest: TestManifest }>;
} {
  return {
    configuredFixedPackageNames: RELEASE_PACKAGES.map(({ name }) => name),
    expectedVersion: version,
    manifests: [
      ...RELEASE_PACKAGES.map(({ name, directory }) => ({
        manifestPath: `${directory}/package.json`,
        manifest: {
          name,
          private: false,
          version,
          repository: {
            type: "git",
            url: "git+https://github.com/vercel-labs/vgpu.git",
            directory,
          },
          publishConfig: { access: "public" },
        },
      })),
      {
        manifestPath: "apps/docs/package.json",
        manifest: { name: "docs", private: true, version: "0.1.0" },
      },
    ],
  };
}

describe("release package validation", () => {
  it("keeps both workflow tarball allowlists aligned and OIDC isolated", () => {
    const workflow = fs.readFileSync(
      new URL("../.github/workflows/release.yml", import.meta.url),
      "utf8"
    );
    const expectedOrder = [
      "@vgpu/wgsl-std",
      "@vgpu/wgsl",
      "@vgpu/core",
      "@vgpu/adapter-node",
      "@vgpu/adapter-mock",
      "@vgpu/render",
      "vgpu",
    ];
    const packageByName = new Map(
      RELEASE_PACKAGES.map((entry) => [entry.name, entry])
    );
    const expectedPairs = expectedOrder.map((name) => {
      const entry = packageByName.get(name);
      if (!entry) throw new Error(`Missing release package fixture ${name}.`);
      return `${entry.name}|${entry.directory}`;
    });
    const workflowPairs = [
      ...workflow.matchAll(
        /"([^"|]+)\|(packages\/[^"|]+)\|[^"\n]+\$\{version\}\.tgz"/g
      ),
    ].map(([, name, directory]) => `${name}|${directory}`);

    expect(workflowPairs).toEqual([...expectedPairs, ...expectedPairs]);
    expect(workflow).toContain(
      'EXPECTED_VERSION="$tag_version" node scripts/check-release-packages.mjs'
    );
    expect(workflow).toContain(
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a"
    );
    expect(workflow).toContain(
      "actions/download-artifact@70fc10c6e5e1ce46ad2ea6f2b72d43f7d47b13c3"
    );

    const verifyStart = workflow.indexOf("  verify-and-pack:");
    const publishStart = workflow.indexOf("\n  publish:", verifyStart);
    const reportStart = workflow.indexOf(
      "\n  report-stable-npm-status:",
      publishStart
    );
    const verifyHeader = workflow.slice(
      verifyStart,
      workflow.indexOf("\n    steps:", verifyStart)
    );
    const publishBlock = workflow.slice(publishStart, reportStart);
    const publishHeader = publishBlock.slice(
      0,
      publishBlock.indexOf("\n    steps:")
    );

    expect(verifyHeader).not.toContain("id-token: write");
    expect(publishHeader).toContain("id-token: write");
    expect(publishBlock).not.toMatch(/uses: (?:actions\/checkout|pnpm\/)/);
    expect(publishBlock).not.toContain("node scripts/");
    expect(publishBlock).toContain("artifact-ids:");
    expect(publishBlock).toContain("digest-mismatch: error");
    expect(publishBlock).toContain('npm publish "./$tarball"');
    for (const flag of [
      "--ignore-scripts",
      "--registry=https://registry.npmjs.org/",
      "--access=public",
      '--tag="$DIST_TAG"',
      "--provenance",
      "--dry-run=false",
    ]) {
      expect(publishBlock).toContain(flag);
    }
  });

  it("accepts exactly the seven allowlisted public packages", () => {
    expect(validateReleasePackages(validInput())).toEqual([]);
  });

  it("rejects an allowlisted package removed from Changesets or made private", () => {
    const input = validInput();
    input.configuredFixedPackageNames =
      input.configuredFixedPackageNames.filter((name) => name !== "@vgpu/core");
    const core = input.manifests.find(
      ({ manifest }) => manifest.name === "@vgpu/core"
    );
    if (!core) throw new Error("Missing core fixture.");
    core.manifest.private = true;

    expect(validateReleasePackages(input)).toEqual(
      expect.arrayContaining([
        "@vgpu/core: missing from the Changesets fixed group",
        "@vgpu/core: package.json must set private to false",
      ])
    );
  });

  it("rejects wrong versions, path/name substitutions, and public extras", () => {
    const input = validInput();
    const core = input.manifests.find(
      ({ manifest }) => manifest.name === "@vgpu/core"
    );
    if (!core) throw new Error("Missing core fixture.");
    core.manifest.name = "@vgpu/not-core";
    core.manifest.version = "0.4.0";
    core.manifest.repository = {
      type: "git",
      url: "git+https://github.com/vercel-labs/vgpu.git",
      directory: "packages/not-core",
    };
    core.manifest.publishConfig = { access: "restricted" };
    input.manifests.push({
      manifestPath: "packages/extra/package.json",
      manifest: { name: "extra", private: false, version },
    });

    expect(validateReleasePackages(input)).toEqual(
      expect.arrayContaining([
        "packages/core/package.json: package name @vgpu/not-core (expected @vgpu/core)",
        "@vgpu/core: 0.4.0 (expected 0.5.0)",
        "@vgpu/core: package.json has invalid repository metadata",
        '@vgpu/core: publishConfig must be exactly { access: "public" }',
        "@vgpu/not-core: public workspace package missing from the release allowlist",
        "extra: public workspace package missing from the release allowlist",
      ])
    );
  });

  it("rejects duplicate and unexpected fixed/package entries", () => {
    const input = validInput();
    input.configuredFixedPackageNames.push("vgpu", "extra");
    input.manifests.push({
      manifestPath: "packages/duplicate/package.json",
      manifest: {
        name: "vgpu",
        private: true,
        version,
        repository: {
          type: "git",
          url: "git+https://github.com/vercel-labs/vgpu.git",
          directory: "packages/duplicate",
        },
        publishConfig: { access: "public" },
      },
    });

    expect(validateReleasePackages(input)).toEqual(
      expect.arrayContaining([
        "vgpu: duplicated in the Changesets fixed group",
        "extra: unexpected package in the Changesets fixed group",
        "vgpu: duplicate workspace package name at packages/vgpu-api/package.json and packages/duplicate/package.json",
      ])
    );
  });
});
