import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_MAIN_SHA,
  MainPrPolicyError,
  PRODUCTION_AUTHORIZATION_CONTEXT,
  STABLE_NPM_AUDIT_CONTEXT,
  evaluateMainPrPolicy,
  promotionVersionFromBranch,
  validateReleasePackageVersions,
} from "./lib/main-pr-policy.mjs";

const baseInput = {
  repository: "vercel-labs/vgpu",
  headRepository: "vercel-labs/vgpu",
  baseRef: "main",
  baseSha: "a".repeat(40),
  currentBaseSha: "a".repeat(40),
  baseProductionStatus: {
    state: "success",
    targetUrl: "https://github.com/vercel-labs/vgpu/actions/runs/1",
    creator: "github-actions[bot]",
  },
  baseIsAncestor: true,
  headRef: "site/new-example",
  headSha: "b".repeat(40),
  currentHeadSha: "b".repeat(40),
  changedPaths: ["apps/docs/examples/new-example.tsx"],
  tagSha: null,
  stableNpmAuditStatus: null,
  releaseVersionErrors: [],
};

function evaluate(overrides: Partial<typeof baseInput> = {}) {
  return evaluateMainPrPolicy({ ...baseInput, ...overrides });
}

function expectPolicyError(
  overrides: Partial<typeof baseInput>,
  expectedMessage: string | RegExp
) {
  expect(() => evaluate(overrides)).toThrowError(MainPrPolicyError);
  expect(() => evaluate(overrides)).toThrowError(expectedMessage);
}

describe("promotionVersionFromBranch", () => {
  it("accepts stable semver promotion branches", () => {
    expect(promotionVersionFromBranch("promote/v0.5.0")).toBe("0.5.0");
    expect(promotionVersionFromBranch("promote/v12.34.56")).toBe("12.34.56");
  });

  it("rejects prereleases, missing versions, and leading zeroes", () => {
    expect(promotionVersionFromBranch("promote/v0.5.0-rc.0")).toBeNull();
    expect(promotionVersionFromBranch("promote/v0.5")).toBeNull();
    expect(promotionVersionFromBranch("promote/v01.5.0")).toBeNull();
  });
});

describe("web-only main PR policy", () => {
  it("allows a non-empty apps/docs-only diff from an up-to-date site branch", () => {
    expect(evaluate()).toMatchObject({ kind: "site" });
  });

  it("rejects an empty diff", () => {
    expectPolicyError({ changedPaths: [] }, "at least one changed file");
  });

  it("rejects any path outside apps/docs", () => {
    expectPolicyError(
      {
        changedPaths: [
          "apps/docs/examples/new-example.tsx",
          "packages/core/src/index.ts",
        ],
      },
      /Disallowed paths: packages\/core\/src\/index\.ts/
    );
  });

  it("rejects a docs-only diff without the site branch prefix", () => {
    expectPolicyError(
      { headRef: "docs/new-example" },
      "must use either site/<name>"
    );
  });

  it("rejects forks and branches that do not contain current main", () => {
    expectPolicyError(
      { headRepository: "contributor/vgpu" },
      "must use a branch in this repository"
    );
    expectPolicyError(
      { baseIsAncestor: false },
      "must contain the current main base commit"
    );
  });

  it("rejects a branch that moved after the event was emitted", () => {
    expectPolicyError(
      { currentHeadSha: "c".repeat(40) },
      "The branch moved while main-policy was running"
    );
  });

  it("rejects a base branch that moved after the event was emitted", () => {
    expectPolicyError(
      { currentBaseSha: "d".repeat(40) },
      "The main branch moved while main-policy was running"
    );
  });

  it("reserves the one-time bootstrap base for a stable promotion", () => {
    expectPolicyError(
      {
        baseSha: BOOTSTRAP_MAIN_SHA,
        currentBaseSha: BOOTSTRAP_MAIN_SHA,
      },
      "bootstrap accepts only a promote/vX.Y.Z"
    );
  });
});

describe("production authorization continuity", () => {
  it("allows a PR when current main is already production-authorized", () => {
    expect(evaluate()).toMatchObject({ kind: "site" });
  });

  it(`rejects a missing ${PRODUCTION_AUTHORIZATION_CONTEXT} status`, () => {
    expectPolicyError(
      { baseProductionStatus: null },
      `has no '${PRODUCTION_AUTHORIZATION_CONTEXT}' status`
    );
  });

  it("rejects a pending parent authorization for both lanes", () => {
    const pendingStatus = {
      state: "pending",
      targetUrl: "https://github.com/vercel-labs/vgpu/actions/runs/1",
      creator: "github-actions[bot]",
    };
    expectPolicyError(
      { baseProductionStatus: pendingStatus },
      "is 'pending', not 'success'"
    );
    expectPolicyError(
      {
        headRef: "promote/v0.5.0",
        baseProductionStatus: pendingStatus,
      },
      "is 'pending', not 'success'"
    );
  });
});

describe("stable promotion main PR policy", () => {
  const promotionHead = "c".repeat(40);
  const promotionInput = {
    headRef: "promote/v0.5.0",
    headSha: promotionHead,
    currentHeadSha: promotionHead,
    changedPaths: ["packages/core/package.json"],
    tagSha: promotionHead,
    stableNpmAuditStatus: {
      state: "success",
      targetUrl: "https://github.com/vercel-labs/vgpu/actions/runs/1",
      creator: "github-actions[bot]",
    },
  };

  it("allows a pinned, published promotion with matching package versions", () => {
    expect(evaluate(promotionInput)).toMatchObject({
      kind: "promotion",
      tag: "v0.5.0",
      version: "0.5.0",
    });
  });

  it("fails closed before the stable tag exists", () => {
    expectPolicyError(
      { ...promotionInput, tagSha: null },
      "Stable tag v0.5.0 does not exist yet"
    );
  });

  it("requires the tag and promotion head to be the same commit", () => {
    expectPolicyError(
      { ...promotionInput, tagSha: "d".repeat(40) },
      "The tag and PR head must be the same commit"
    );
  });

  it(`requires a successful ${STABLE_NPM_AUDIT_CONTEXT} status`, () => {
    expectPolicyError(
      { ...promotionInput, stableNpmAuditStatus: null },
      `has no '${STABLE_NPM_AUDIT_CONTEXT}' status`
    );
    expectPolicyError(
      {
        ...promotionInput,
        stableNpmAuditStatus: {
          state: "failure",
          targetUrl: null,
          creator: null,
        },
      },
      `is 'failure', not 'success'`
    );
  });

  it("rejects mismatched fixed-package versions", () => {
    expectPolicyError(
      {
        ...promotionInput,
        releaseVersionErrors: ["@vgpu/core: 0.4.0 (expected 0.5.0)"],
      },
      "Promotion package validation failed"
    );
  });
});

describe("release package version validation", () => {
  it("accepts fixed public packages at the release version", () => {
    expect(
      validateReleasePackageVersions({
        fixedPackageNames: ["vgpu", "@vgpu/core"],
        expectedVersion: "0.5.0",
        manifests: [
          {
            manifestPath: "packages/vgpu-api/package.json",
            manifest: { name: "vgpu", version: "0.5.0" },
          },
          {
            manifestPath: "packages/core/package.json",
            manifest: { name: "@vgpu/core", version: "0.5.0" },
          },
          {
            manifestPath: "apps/docs/package.json",
            manifest: { name: "docs", private: true, version: "0.1.0" },
          },
        ],
      })
    ).toEqual([]);
  });

  it("reports missing, mismatched, and ungrouped public packages", () => {
    expect(
      validateReleasePackageVersions({
        fixedPackageNames: ["vgpu", "@vgpu/core"],
        expectedVersion: "0.5.0",
        manifests: [
          {
            manifestPath: "packages/vgpu-api/package.json",
            manifest: { name: "vgpu", version: "0.4.0" },
          },
          {
            manifestPath: "packages/extra/package.json",
            manifest: { name: "extra", version: "1.0.0" },
          },
        ],
      })
    ).toEqual([
      "vgpu: 0.4.0 (expected 0.5.0)",
      "@vgpu/core: package.json not found",
      "extra: public workspace package missing from the fixed group",
    ]);
  });

  it("rejects a fixed package made private", () => {
    expect(
      validateReleasePackageVersions({
        fixedPackageNames: ["vgpu"],
        expectedVersion: "0.5.0",
        manifests: [
          {
            manifestPath: "packages/vgpu-api/package.json",
            manifest: { name: "vgpu", version: "0.5.0", private: true },
          },
        ],
      })
    ).toContain("vgpu: package.json must not be private");
  });
});
