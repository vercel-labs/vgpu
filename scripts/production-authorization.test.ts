import { describe, expect, it, vi } from "vitest";
import {
  BOOTSTRAP_MAIN_SHA,
  CI_REQUIRED_JOBS,
  CI_WORKFLOW_ID,
  CI_WORKFLOW_PATH,
  CONTROL_PLANE_BRANCH,
  GITHUB_ACTIONS_APP_ID,
  MAIN_POLICY_WORKFLOW_PATH,
  PUBLISHED_PACKAGES,
  PRODUCTION_AUTHORIZATION_CONTEXT,
  PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX,
  PRODUCTION_AUTHORIZATION_WORKFLOW_PATH,
  RELEASE_WORKFLOW_ID,
  RELEASE_WORKFLOW_PATH,
  STABLE_NPM_AUDIT_CONTEXT,
  ProductionAuthorizationError,
  confirmsProductionAuthorizationWrite,
  evaluateProductionAuthorization,
  inspectExistingProductionAuthorization,
  isAlreadyProductionAuthorized,
  latestCommitStatus,
  mainPolicyCheckExternalId,
  mainPolicyRunIdFromDetailsUrl,
  mainPolicyRunName,
  normalizeGraphqlPullRequest,
  parseMainPolicyCheckExternalId,
  releaseRunIdFromStatusTarget,
  requireCurrentMainTip,
  requireUnchangedStableRefs,
  selectCiPushRunForRelease,
  validateCiWorkflowJobs,
  validateCiWorkflowRun,
  validateCanonicalProductionAuthorizationStatus,
  validateNpmEvidence,
  validateProductionAuthorizationWorkflowRun,
  validateReleasePackageVersions,
} from "./lib/production-authorization.mjs";

const repository = "vercel-labs/vgpu";
const parentSha = "a".repeat(40);
const candidateSha = "b".repeat(40);
const prHeadSha = "c".repeat(40);
const candidateTreeSha = "d".repeat(40);
const trustedPolicySha = "f".repeat(40);

const successfulMainPolicyRun = {
  id: 200,
  run_attempt: 1,
  path: MAIN_POLICY_WORKFLOW_PATH,
  event: "pull_request_target",
  status: "completed",
  conclusion: "success",
  head_branch: "site/new-example",
  head_sha: prHeadSha,
  head_repository: { full_name: repository },
  display_title: `Main policy PR #42: ${parentSha} -> ${prHeadSha}`,
};

const successfulMainPolicy = {
  id: 20,
  name: "main-policy",
  status: "completed",
  conclusion: "success",
  head_sha: prHeadSha,
  app: { id: GITHUB_ACTIONS_APP_ID },
  details_url: `https://github.com/${repository}/actions/runs/200`,
  external_id: `main-policy:200:1:${trustedPolicySha}:42:${parentSha}:${prHeadSha}`,
};

const parentAuthorization = {
  id: 10,
  context: PRODUCTION_AUTHORIZATION_CONTEXT,
  state: "success",
  creator: { login: "github-actions[bot]" },
  target_url: `https://github.com/${repository}/actions/runs/100`,
};

const parentAuthorizationRun = {
  id: 100,
  workflow_id: 777,
  display_title: `${PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX} ${parentSha}`,
  path: PRODUCTION_AUTHORIZATION_WORKFLOW_PATH,
  event: "workflow_run",
  status: "completed",
  conclusion: "success",
  head_branch: CONTROL_PLANE_BRANCH,
  head_sha: trustedPolicySha,
  head_repository: { full_name: repository },
};

function pullRequest(headRef: string, overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: "closed",
    merged_at: "2026-09-03T20:00:00Z",
    merge_commit_sha: candidateSha,
    base: { ref: "main", sha: parentSha },
    head: { ref: headRef, sha: prHeadSha, repo: { full_name: repository } },
    ...overrides,
  };
}

function mainPolicyEvidence(pr: ReturnType<typeof pullRequest>) {
  const workflowRun = {
    ...successfulMainPolicyRun,
    head_branch: pr.head.ref,
    head_sha: pr.head.sha,
    display_title: mainPolicyRunName(pr),
  };
  const checkRun = {
    ...successfulMainPolicy,
    head_sha: pr.head.sha,
    external_id: mainPolicyCheckExternalId({
      workflowRun,
      pullRequest: pr,
      policySha: trustedPolicySha,
    }),
  };
  return { checkRun, workflowRun };
}

const siteInput = {
  authorizationWorkflowId: 777,
  baseHasMainPolicy: true,
  candidateHasMainPolicy: true,
  candidateSha,
  candidateTreeSha,
  changedPaths: ["apps/docs/examples/new-example.tsx"],
  checkRuns: [successfulMainPolicy],
  mainPolicyWorkflowRun: successfulMainPolicyRun,
  mainPolicyPolicyIsAncestor: true,
  mainPolicyPolicyMatchesTrusted: true,
  mainPolicyPolicySha: trustedPolicySha,
  npmEvidence: [],
  packageVersionErrors: [],
  parentIsTagAncestor: false,
  parentAuthorizationRun,
  parentProductionStatus: parentAuthorization,
  parents: [parentSha, prHeadSha],
  pullRequests: [pullRequest("site/new-example")],
  release: null,
  releaseJobs: [],
  releaseRun: null,
  repository,
  stableNpmAuditStatus: null,
  tagIsInCanary: false,
  tagSha: null,
  tagTreeSha: null,
  trustedPolicySha,
};

const version = "0.5.0";
const releaseRunId = 123456;
const npmEvidence = PUBLISHED_PACKAGES.map((name) => ({
  name,
  versionExists: true,
  latest: version,
}));

const stableInput = {
  ...siteInput,
  changedPaths: ["packages/core/package.json"],
  npmEvidence,
  parentIsTagAncestor: true,
  parents: [parentSha, prHeadSha],
  pullRequests: [pullRequest(`promote/v${version}`)],
  mainPolicyWorkflowRun: {
    ...successfulMainPolicyRun,
    head_branch: `promote/v${version}`,
  },
  release: {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    published_at: "2026-09-03T19:00:00Z",
  },
  releaseJobs: [
    { name: "publish", status: "completed", conclusion: "success" },
  ],
  releaseRun: {
    id: releaseRunId,
    workflow_id: RELEASE_WORKFLOW_ID,
    path: RELEASE_WORKFLOW_PATH,
    event: "release",
    status: "completed",
    conclusion: "success",
    head_sha: prHeadSha,
    head_branch: `v${version}`,
  },
  stableNpmAuditStatus: {
    id: 30,
    context: STABLE_NPM_AUDIT_CONTEXT,
    state: "success",
    target_url: `https://github.com/${repository}/actions/runs/${releaseRunId}`,
  },
  tagIsInCanary: true,
  tagSha: prHeadSha,
  tagTreeSha: candidateTreeSha,
};

function evaluateSite(overrides: Record<string, unknown> = {}) {
  return evaluateProductionAuthorization({ ...siteInput, ...overrides });
}

function evaluateStable(overrides: Record<string, unknown> = {}) {
  return evaluateProductionAuthorization({ ...stableInput, ...overrides });
}

function expectPolicyError(
  callback: () => unknown,
  expectedMessage: string | RegExp
) {
  expect(callback).toThrowError(ProductionAuthorizationError);
  expect(callback).toThrowError(expectedMessage);
}

describe("CI workflow_run validation", () => {
  const event = {
    id: "100",
    workflowId: CI_WORKFLOW_ID,
    path: CI_WORKFLOW_PATH,
    triggeringEvent: "push",
    status: "completed",
    conclusion: "success",
    headBranch: "main",
    headSha: candidateSha,
    headRepository: repository,
  };
  const run = {
    id: 100,
    workflow_id: CI_WORKFLOW_ID,
    path: CI_WORKFLOW_PATH,
    event: "push",
    status: "completed",
    conclusion: "success",
    head_branch: "main",
    head_sha: candidateSha,
    head_repository: { full_name: repository },
  };

  it("accepts only the canonical successful CI push on main", () => {
    expect(validateCiWorkflowRun({ event, run, repository })).toBe(
      candidateSha
    );
  });

  it("rejects a same-name workflow with another ID or path", () => {
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event: { ...event, workflowId: 999 },
          run: { ...run, workflow_id: 999 },
          repository,
        }),
      `workflow ID ${CI_WORKFLOW_ID}`
    );
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event: { ...event, path: ".github/workflows/fake.yml" },
          run: { ...run, path: ".github/workflows/fake.yml" },
          repository,
        }),
      CI_WORKFLOW_PATH
    );
  });

  it("rejects PR, failed, foreign-repository, and stale-payload runs", () => {
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event: { ...event, triggeringEvent: "pull_request" },
          run: { ...run, event: "pull_request" },
          repository,
        }),
      "triggered by a push"
    );
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event: { ...event, conclusion: "failure" },
          run: { ...run, conclusion: "failure" },
          repository,
        }),
      "must have succeeded"
    );
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event: { ...event, headRepository: "fork/vgpu" },
          run: { ...run, head_repository: { full_name: "fork/vgpu" } },
          repository,
        }),
      `must belong to ${repository}`
    );
    expectPolicyError(
      () =>
        validateCiWorkflowRun({
          event,
          run: { ...run, head_sha: "e".repeat(40) },
          repository,
        }),
      "head SHA mismatch"
    );
  });

  it("requires every canonical CI job to have a successful execution", () => {
    const jobs = CI_REQUIRED_JOBS.map((name, id) => ({
      id,
      name,
      status: "completed",
      conclusion: "success",
    }));
    expect(() => validateCiWorkflowJobs(jobs)).not.toThrow();
    expectPolicyError(
      () =>
        validateCiWorkflowJobs(jobs.filter((job) => job.name !== "docker-gpu")),
      "no completed, successful 'docker-gpu' job"
    );
    expectPolicyError(
      () =>
        validateCiWorkflowJobs(
          jobs.map((job) =>
            job.name === "docs-app-build"
              ? { ...job, conclusion: "skipped" }
              : job
          )
        ),
      "no completed, successful 'docs-app-build' job"
    );
  });

  it("selects the latest successful canonical push CI for a release SHA", () => {
    const canonical = {
      id: 12,
      workflow_id: CI_WORKFLOW_ID,
      path: CI_WORKFLOW_PATH,
      event: "push",
      status: "completed",
      conclusion: "success",
      head_branch: "canary",
      head_sha: candidateSha,
      head_repository: { full_name: repository },
    };
    expect(
      selectCiPushRunForRelease({
        runs: [
          { ...canonical, id: 11, conclusion: "failure" },
          canonical,
          { ...canonical, id: 99, head_sha: "f".repeat(40) },
        ],
        repository,
        releaseBranch: "canary",
        releaseSha: candidateSha,
      })
    ).toEqual(canonical);

    expectPolicyError(
      () =>
        selectCiPushRunForRelease({
          runs: [{ ...canonical, id: 13, conclusion: "failure" }],
          repository,
          releaseBranch: "canary",
          releaseSha: candidateSha,
        }),
      "expected completed/success"
    );
  });
});

describe("production-authorization run provenance", () => {
  it("binds a canonical workflow run to the SHA named by its run title", () => {
    expect(
      validateProductionAuthorizationWorkflowRun({
        run: parentAuthorizationRun,
        repository,
        authorizedSha: parentSha,
        requireSuccess: true,
      })
    ).toBe(777);
    expectPolicyError(
      () =>
        validateProductionAuthorizationWorkflowRun({
          run: parentAuthorizationRun,
          repository,
          authorizedSha: "f".repeat(40),
          requireSuccess: true,
        }),
      "for ffffffffffffffffffffffffffffffffffffffff"
    );
    expectPolicyError(
      () =>
        validateProductionAuthorizationWorkflowRun({
          run: { ...parentAuthorizationRun, head_branch: "main" },
          repository,
          authorizedSha: parentSha,
          requireSuccess: true,
        }),
      PRODUCTION_AUTHORIZATION_WORKFLOW_PATH
    );
  });

  it("accepts only a status linked to the same canonical workflow and SHA", () => {
    expect(() =>
      validateCanonicalProductionAuthorizationStatus({
        status: parentAuthorization,
        run: parentAuthorizationRun,
        repository,
        authorizedSha: parentSha,
        authorizationWorkflowId: 777,
      })
    ).not.toThrow();
    expectPolicyError(
      () =>
        validateCanonicalProductionAuthorizationStatus({
          status: parentAuthorization,
          run: parentAuthorizationRun,
          repository,
          authorizedSha: parentSha,
          authorizationWorkflowId: 778,
        }),
      "expected 778"
    );
  });

  it("propagates a linked-run read failure before classifying an existing success", async () => {
    const readFailure = new Error("GitHub API unavailable");
    const readRun = vi.fn().mockRejectedValue(readFailure);

    await expect(
      inspectExistingProductionAuthorization({
        status: parentAuthorization,
        repository,
        authorizedSha: parentSha,
        authorizationWorkflowId: 777,
        readRun,
      })
    ).rejects.toBe(readFailure);
    expect(readRun).toHaveBeenCalledExactlyOnceWith("100");
  });

  it("classifies canonical validation failures only after reading the linked run", async () => {
    const readRun = vi.fn().mockResolvedValue({
      ...parentAuthorizationRun,
      display_title: `${PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX} ${candidateSha}`,
    });

    await expect(
      inspectExistingProductionAuthorization({
        status: parentAuthorization,
        repository,
        authorizedSha: parentSha,
        authorizationWorkflowId: 777,
        readRun,
      })
    ).resolves.toMatchObject({
      canonical: false,
      reason: expect.stringContaining(`for ${parentSha}`),
    });
    expect(readRun).toHaveBeenCalledExactlyOnceWith("100");
  });
});

describe("live main continuity", () => {
  it("accepts both initial and final reads when main still points at the candidate", () => {
    expect(() =>
      requireCurrentMainTip({
        candidateSha,
        currentMainSha: candidateSha,
        phase: "before policy evaluation",
      })
    ).not.toThrow();
    expect(() =>
      requireCurrentMainTip({
        candidateSha,
        currentMainSha: candidateSha,
        phase: "during policy evaluation",
      })
    ).not.toThrow();
  });

  it("requires the stable tag and canary refs to remain unchanged", () => {
    const tagSha = "e".repeat(40);
    const canarySha = "f".repeat(40);
    expect(() =>
      requireUnchangedStableRefs({
        tag: "v0.5.0",
        expectedTagSha: tagSha,
        currentTagSha: tagSha,
        expectedCanarySha: canarySha,
        currentCanarySha: canarySha,
      })
    ).not.toThrow();

    expectPolicyError(
      () =>
        requireUnchangedStableRefs({
          tag: "v0.5.0",
          expectedTagSha: tagSha,
          currentTagSha: "1".repeat(40),
          expectedCanarySha: canarySha,
          currentCanarySha: canarySha,
        }),
      "v0.5.0 moved during policy evaluation"
    );
    expectPolicyError(
      () =>
        requireUnchangedStableRefs({
          tag: "v0.5.0",
          expectedTagSha: tagSha,
          currentTagSha: tagSha,
          expectedCanarySha: canarySha,
          currentCanarySha: "2".repeat(40),
        }),
      "canary moved during policy evaluation"
    );
  });

  it("fails if main moves before either read", () => {
    expectPolicyError(
      () =>
        requireCurrentMainTip({
          candidateSha,
          currentMainSha: "f".repeat(40),
          phase: "during policy evaluation",
        }),
      "main moved during policy evaluation"
    );
  });
});

describe("web-only authorization", () => {
  it("authorizes a non-empty apps/docs-only merge commit", () => {
    expect(evaluateSite()).toMatchObject({ kind: "site", bootstrap: false });
  });

  it("rejects a one-parent squash or rebase commit", () => {
    expectPolicyError(
      () => evaluateSite({ parents: [parentSha] }),
      "two-parent PR merge commit"
    );
  });

  it("rejects empty, outside-path, cross-boundary rename, and wrong merge-parent diffs", () => {
    expectPolicyError(
      () => evaluateSite({ changedPaths: [] }),
      "at least one file"
    );
    expectPolicyError(
      () => evaluateSite({ changedPaths: ["packages/core/src/index.ts"] }),
      "Disallowed paths"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          changedPaths: ["packages/core/old.ts", "apps/docs/examples/moved.ts"],
        }),
      "packages/core/old.ts"
    );
    expectPolicyError(
      () => evaluateSite({ parents: [parentSha, "e".repeat(40)] }),
      "second parent"
    );
  });

  it("requires the immediate first parent to be production-authorized", () => {
    expectPolicyError(
      () => evaluateSite({ parentProductionStatus: null }),
      `has no '${PRODUCTION_AUTHORIZATION_CONTEXT}' status`
    );
    expectPolicyError(
      () =>
        evaluateSite({
          parentProductionStatus: { ...parentAuthorization, state: "pending" },
        }),
      "expected success"
    );
  });

  it("verifies non-bootstrap parent authorization provenance", () => {
    expectPolicyError(
      () =>
        evaluateSite({
          parentProductionStatus: {
            ...parentAuthorization,
            creator: { login: "maintainer" },
          },
        }),
      "canonical success from github-actions[bot]"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          parentAuthorizationRun: {
            ...parentAuthorizationRun,
            path: ".github/workflows/fake.yml",
          },
        }),
      PRODUCTION_AUTHORIZATION_WORKFLOW_PATH
    );
    expectPolicyError(
      () =>
        evaluateSite({
          parentAuthorizationRun: {
            ...parentAuthorizationRun,
            display_title: `${PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX} ${"f".repeat(
              40
            )}`,
          },
        }),
      PRODUCTION_AUTHORIZATION_WORKFLOW_PATH
    );
  });

  it("rejects rebase-style multi-commit pushes and direct or fork commits", () => {
    expectPolicyError(
      () =>
        evaluateSite({
          pullRequests: [
            pullRequest("site/new-example", {
              base: { ref: "main", sha: "e".repeat(40) },
            }),
          ],
        }),
      "first parent"
    );
    expectPolicyError(
      () => evaluateSite({ pullRequests: [] }),
      "exactly one merged PR"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          pullRequests: [
            pullRequest("site/new-example", {
              merge_commit_sha: "e".repeat(40),
            }),
          ],
        }),
      "merge commit"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          pullRequests: [
            pullRequest("site/new-example", {
              head: {
                ref: "site/new-example",
                sha: prHeadSha,
                repo: { full_name: "fork/vgpu" },
              },
            }),
          ],
        }),
      "not a fork"
    );
  });

  it("always requires main-policy from the GitHub Actions app", () => {
    expectPolicyError(
      () => evaluateSite({ checkRuns: [] }),
      "has no 'main-policy'"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [{ ...successfulMainPolicy, app: { id: 999 } }],
        }),
      `expected ${GITHUB_ACTIONS_APP_ID}`
    );
  });

  it("binds main-policy to its canonical workflow run and PR head", () => {
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [
            {
              ...successfulMainPolicy,
              details_url:
                "https://github.com/vercel-labs/vgpu/actions/runs/200/job/300",
            },
          ],
        }),
      "exact GitHub Actions run URL"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          mainPolicyWorkflowRun: {
            ...successfulMainPolicyRun,
            path: ".github/workflows/fake.yml",
          },
        }),
      MAIN_POLICY_WORKFLOW_PATH
    );
    expectPolicyError(
      () =>
        evaluateSite({
          mainPolicyWorkflowRun: {
            ...successfulMainPolicyRun,
            head_sha: "e".repeat(40),
          },
        }),
      "linked main-policy run targeted"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [
            {
              ...successfulMainPolicy,
              head_sha: "e".repeat(40),
            },
          ],
        }),
      "expected PR head"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [
            {
              ...successfulMainPolicy,
              external_id: "main-policy:replayed",
            },
          ],
        }),
      "not bound to the exact trusted workflow attempt"
    );
  });

  it("accepts an older canary policy revision only when it is an identical ancestor", () => {
    const previousPolicySha = "1".repeat(40);
    const pr = pullRequest("site/new-example");
    const historicalCheck = {
      ...successfulMainPolicy,
      external_id: mainPolicyCheckExternalId({
        workflowRun: successfulMainPolicyRun,
        pullRequest: pr,
        policySha: previousPolicySha,
      }),
    };

    expect(
      evaluateSite({
        checkRuns: [historicalCheck],
        mainPolicyPolicySha: previousPolicySha,
      })
    ).toMatchObject({ kind: "site" });
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [historicalCheck],
          mainPolicyPolicySha: previousPolicySha,
          mainPolicyPolicyMatchesTrusted: false,
        }),
      "does not contain the same critical policy files"
    );
    expectPolicyError(
      () =>
        evaluateSite({
          checkRuns: [historicalCheck],
          mainPolicyPolicySha: previousPolicySha,
          mainPolicyPolicyIsAncestor: false,
        }),
      "is not an ancestor"
    );
  });
});

describe("stable promotion authorization", () => {
  it("authorizes a released tag whose tree exactly matches main", () => {
    expect(evaluateStable()).toMatchObject({
      kind: "stable",
      tag: "v0.5.0",
      version: "0.5.0",
      bootstrap: false,
    });
  });

  it("rejects squash and rebase-style stable promotions", () => {
    expectPolicyError(
      () => evaluateStable({ parents: [parentSha] }),
      "two-parent PR merge commit"
    );
    expectPolicyError(
      () =>
        evaluateStable({
          pullRequests: [
            pullRequest(`promote/v${version}`, {
              base: { ref: "main", sha: "e".repeat(40) },
            }),
          ],
        }),
      "first parent"
    );
  });

  it("requires the immediate parent status and ancestry into the stable tag", () => {
    expectPolicyError(
      () => evaluateStable({ parentProductionStatus: null }),
      `has no '${PRODUCTION_AUTHORIZATION_CONTEXT}' status`
    );
    expectPolicyError(
      () => evaluateStable({ parentIsTagAncestor: false }),
      "is not an ancestor"
    );
  });

  it("allows a missing base policy only for a successful, exact one-time bootstrap", () => {
    const bootstrapPr = pullRequest(`promote/v${version}`, {
      base: { ref: "main", sha: BOOTSTRAP_MAIN_SHA },
    });
    const bootstrapPolicy = mainPolicyEvidence(bootstrapPr);
    const result = evaluateStable({
      baseHasMainPolicy: false,
      candidateHasMainPolicy: true,
      checkRuns: [bootstrapPolicy.checkRun],
      mainPolicyWorkflowRun: bootstrapPolicy.workflowRun,
      parents: [BOOTSTRAP_MAIN_SHA, prHeadSha],
      parentAuthorizationRun: null,
      parentProductionStatus: {
        ...parentAuthorization,
        creator: { login: "maintainer" },
        target_url: "https://github.com/vercel-labs/vgpu/releases/tag/v0.4.0",
      },
      pullRequests: [bootstrapPr],
    });
    expect(result).toMatchObject({ kind: "stable", bootstrap: true });

    expectPolicyError(
      () =>
        evaluateStable({
          baseHasMainPolicy: false,
          candidateHasMainPolicy: true,
          checkRuns: [
            {
              ...bootstrapPolicy.checkRun,
              status: "completed",
              conclusion: "failure",
            },
          ],
          mainPolicyWorkflowRun: bootstrapPolicy.workflowRun,
          parents: [BOOTSTRAP_MAIN_SHA, prHeadSha],
          parentAuthorizationRun: null,
          parentProductionStatus: {
            ...parentAuthorization,
            creator: { login: "maintainer" },
            target_url: null,
          },
          pullRequests: [bootstrapPr],
        }),
      "must be completed successfully"
    );

    expectPolicyError(
      () =>
        evaluateStable({
          baseHasMainPolicy: false,
          candidateHasMainPolicy: false,
          checkRuns: [bootstrapPolicy.checkRun],
          mainPolicyWorkflowRun: bootstrapPolicy.workflowRun,
          parents: [BOOTSTRAP_MAIN_SHA, prHeadSha],
          parentAuthorizationRun: null,
          parentProductionStatus: parentAuthorization,
          pullRequests: [bootstrapPr],
        }),
      "candidate policy must exactly match"
    );
  });

  it("does not apply the bootstrap exception to site, another parent, or a base with policy", () => {
    const bootstrapSitePr = pullRequest("site/bootstrap", {
      base: { ref: "main", sha: BOOTSTRAP_MAIN_SHA },
    });
    expectPolicyError(
      () =>
        evaluateSite({
          baseHasMainPolicy: false,
          checkRuns: [],
          parents: [BOOTSTRAP_MAIN_SHA, prHeadSha],
          parentProductionStatus: parentAuthorization,
          pullRequests: [bootstrapSitePr],
        }),
      "base without policy is allowed only"
    );
    expectPolicyError(
      () => evaluateStable({ checkRuns: [], baseHasMainPolicy: false }),
      "base without policy is allowed only"
    );
    const bootstrapPr = pullRequest(`promote/v${version}`, {
      base: { ref: "main", sha: BOOTSTRAP_MAIN_SHA },
    });
    expectPolicyError(
      () =>
        evaluateStable({
          baseHasMainPolicy: true,
          checkRuns: [],
          parents: [BOOTSTRAP_MAIN_SHA, prHeadSha],
          parentProductionStatus: parentAuthorization,
          pullRequests: [bootstrapPr],
        }),
      "has no 'main-policy'"
    );
  });

  it("rejects tag/head and main/tag tree mismatches", () => {
    expectPolicyError(
      () => evaluateStable({ tagSha: "e".repeat(40) }),
      "promotion PR head"
    );
    expectPolicyError(
      () => evaluateStable({ tagTreeSha: "e".repeat(40) }),
      "does not exactly match"
    );
  });

  it("requires a normal published GitHub Release and canary ancestry", () => {
    expectPolicyError(
      () => evaluateStable({ release: null }),
      "does not exist"
    );
    expectPolicyError(
      () =>
        evaluateStable({
          release: { ...stableInput.release, prerelease: true },
        }),
      "non-prerelease"
    );
    expectPolicyError(
      () => evaluateStable({ tagIsInCanary: false }),
      "not an ancestor of the current canary"
    );
  });

  it("requires a successful audit status linked to the canonical successful Release run", () => {
    expectPolicyError(
      () => evaluateStable({ stableNpmAuditStatus: null }),
      `has no '${STABLE_NPM_AUDIT_CONTEXT}' status`
    );
    expectPolicyError(
      () =>
        evaluateStable({
          stableNpmAuditStatus: {
            ...stableInput.stableNpmAuditStatus,
            target_url: "https://example.com/fake",
          },
        }),
      "must link to a GitHub Actions run"
    );
    expectPolicyError(
      () =>
        evaluateStable({
          releaseRun: { ...stableInput.releaseRun, workflow_id: 999 },
        }),
      `Release workflow ${RELEASE_WORKFLOW_ID}`
    );
    expectPolicyError(
      () => evaluateStable({ releaseJobs: [] }),
      "no successful publish job"
    );
  });

  it("accepts a successful publish job from an earlier attempt of the same Release run", () => {
    expect(
      evaluateStable({
        releaseJobs: [
          {
            id: 2,
            name: "Record stable npm publication status",
            status: "completed",
            conclusion: "success",
          },
          {
            id: 1,
            name: "publish",
            status: "completed",
            conclusion: "success",
          },
        ],
      })
    ).toMatchObject({ kind: "stable", tag: "v0.5.0" });
  });

  it("requires every package to exist at npm latest", () => {
    expectPolicyError(
      () =>
        evaluateStable({
          npmEvidence: npmEvidence.map((item) =>
            item.name === "vgpu" ? { ...item, latest: "0.4.0" } : item
          ),
        }),
      "npm latest=0.4.0"
    );
    expectPolicyError(
      () =>
        evaluateStable({
          npmEvidence: npmEvidence.map((item) =>
            item.name === "@vgpu/core"
              ? { ...item, versionExists: false }
              : item
          ),
        }),
      "is not present"
    );
  });
});

describe("status and release helpers", () => {
  it("confirms only the exact success written by the current authorization run", () => {
    const targetUrl = `https://github.com/${repository}/actions/runs/123`;
    const status = {
      context: PRODUCTION_AUTHORIZATION_CONTEXT,
      state: "success",
      target_url: targetUrl,
      creator: { login: "github-actions[bot]" },
    };

    expect(confirmsProductionAuthorizationWrite({ status, targetUrl })).toBe(
      true
    );
    expect(
      confirmsProductionAuthorizationWrite({
        status: { ...status, target_url: `${targetUrl}/wrong` },
        targetUrl,
      })
    ).toBe(false);
    expect(
      confirmsProductionAuthorizationWrite({
        status: { ...status, creator: { login: "octocat" } },
        targetUrl,
      })
    ).toBe(false);
  });

  it("detects an existing success only from the latest exact production status", () => {
    expect(
      isAlreadyProductionAuthorized([
        { id: 2, context: PRODUCTION_AUTHORIZATION_CONTEXT, state: "success" },
      ])
    ).toBe(true);
    expect(
      isAlreadyProductionAuthorized([
        { id: 2, context: PRODUCTION_AUTHORIZATION_CONTEXT, state: "success" },
        { id: 3, context: PRODUCTION_AUTHORIZATION_CONTEXT, state: "failure" },
      ])
    ).toBe(false);
    expect(
      isAlreadyProductionAuthorized([
        { id: 4, context: "similarly named", state: "success" },
      ])
    ).toBe(false);
  });

  it("normalizes canonical GraphQL PR merge/base/head fields", () => {
    expect(
      normalizeGraphqlPullRequest({
        number: 408,
        state: "MERGED",
        merged: true,
        mergedAt: "2026-09-03T20:12:01Z",
        mergeCommit: { oid: candidateSha },
        baseRefName: "main",
        baseRefOid: parentSha,
        headRefName: "site/new-example",
        headRefOid: prHeadSha,
        headRepository: { nameWithOwner: repository },
      })
    ).toEqual({
      number: 408,
      state: "closed",
      merged_at: "2026-09-03T20:12:01Z",
      merge_commit_sha: candidateSha,
      base: { ref: "main", sha: parentSha },
      head: {
        ref: "site/new-example",
        sha: prHeadSha,
        repo: { full_name: repository },
      },
    });
  });

  it("selects the newest exact status context", () => {
    expect(
      latestCommitStatus(
        [
          {
            id: 1,
            context: PRODUCTION_AUTHORIZATION_CONTEXT,
            state: "success",
          },
          {
            id: 3,
            context: PRODUCTION_AUTHORIZATION_CONTEXT,
            state: "failure",
          },
          { id: 4, context: "another", state: "success" },
        ],
        PRODUCTION_AUTHORIZATION_CONTEXT
      )
    ).toMatchObject({ id: 3, state: "failure" });
  });

  it("accepts only exact GitHub run target URLs", () => {
    expect(
      releaseRunIdFromStatusTarget(
        `https://github.com/${repository}/actions/runs/123`,
        repository
      )
    ).toBe("123");
    expect(
      releaseRunIdFromStatusTarget(
        `https://github.com/${repository}/actions/runs/123?fake=1`,
        repository
      )
    ).toBeNull();
  });

  it("accepts only exact main-policy run details URLs", () => {
    expect(
      mainPolicyRunIdFromDetailsUrl(
        `https://github.com/${repository}/actions/runs/200`,
        repository
      )
    ).toBe("200");
    expect(
      mainPolicyRunIdFromDetailsUrl(
        `https://github.com/${repository}/actions/runs/200/job/300`,
        repository
      )
    ).toBeNull();
  });

  it("binds main-policy metadata to the workflow attempt and exact PR", () => {
    const pr = pullRequest("site/new-example");
    expect(mainPolicyRunName(pr)).toBe(
      `Main policy PR #42: ${parentSha} -> ${prHeadSha}`
    );
    expect(
      mainPolicyCheckExternalId({
        workflowRun: successfulMainPolicyRun,
        pullRequest: pr,
        policySha: trustedPolicySha,
      })
    ).toBe(successfulMainPolicy.external_id);
    expect(
      parseMainPolicyCheckExternalId(successfulMainPolicy.external_id)
    ).toEqual({
      runId: "200",
      runAttempt: "1",
      policySha: trustedPolicySha,
      pullRequestNumber: "42",
      baseSha: parentSha,
      headSha: prHeadSha,
    });
    expect(parseMainPolicyCheckExternalId("main-policy:invalid")).toBeNull();
  });
});

describe("package evidence", () => {
  it("validates the exact Changesets fixed group and versions", () => {
    expect(
      validateReleasePackageVersions({
        configuredFixedPackageNames: [...PUBLISHED_PACKAGES],
        expectedVersion: version,
        manifests: PUBLISHED_PACKAGES.map((name) => ({
          manifestPath: `${name}/package.json`,
          manifest: { name, version },
        })),
      })
    ).toEqual([]);
  });

  it("reports missing fixed packages and version mismatches", () => {
    const errors = validateReleasePackageVersions({
      configuredFixedPackageNames: ["vgpu"],
      expectedVersion: version,
      manifests: [
        {
          manifestPath: "packages/vgpu-api/package.json",
          manifest: { name: "vgpu", version: "0.4.0" },
        },
      ],
    });
    expect(errors).toContain("vgpu: 0.4.0 (expected 0.5.0)");
    expect(errors).toContain(
      "@vgpu/core: missing from the Changesets fixed group"
    );
  });

  it("rejects an allowlisted package made private", () => {
    const manifests = PUBLISHED_PACKAGES.map((name) => ({
      manifestPath: `${name}/package.json`,
      manifest: { name, version, private: name === "@vgpu/core" },
    }));

    expect(
      validateReleasePackageVersions({
        configuredFixedPackageNames: [...PUBLISHED_PACKAGES],
        expectedVersion: version,
        manifests,
      })
    ).toContain("@vgpu/core: package.json must not be private");
  });

  it("rejects incomplete npm evidence", () => {
    expectPolicyError(
      () =>
        validateNpmEvidence({
          evidence: npmEvidence.slice(1),
          expectedVersion: version,
        }),
      "Expected npm evidence"
    );
  });
});
