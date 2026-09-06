#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  CI_WORKFLOW_ID,
  CI_WORKFLOW_PATH,
  PUBLISHED_PACKAGES,
  PRODUCTION_AUTHORIZATION_CONTEXT,
  ProductionAuthorizationError,
  STABLE_NPM_AUDIT_CONTEXT,
  confirmsProductionAuthorizationWrite,
  evaluateProductionAuthorization,
  inspectExistingProductionAuthorization,
  latestCommitStatus,
  latestMainPolicyCheck,
  mainPolicyRunIdFromDetailsUrl,
  normalizeGraphqlPullRequest,
  parseMainPolicyCheckExternalId,
  promotionVersionFromBranch,
  releaseRunIdFromStatusTarget,
  requireCurrentMainTip,
  requireSha,
  requireUnchangedStableRefs,
  validateCiWorkflowJobs,
  validateCiWorkflowRun,
  validateProductionAuthorizationWorkflowRun,
  validateReleasePackageVersions,
} from "./lib/production-authorization.mjs";

const MAIN_POLICY_PATHS = Object.freeze([
  ".github/workflows/main-policy.yml",
  "scripts/check-main-pr-policy.mjs",
  "scripts/lib/main-pr-policy.mjs",
]);

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new ProductionAuthorizationError(
      `Missing required environment variable ${name}.`
    );
  }
  return value;
}

function git(repositoryRoot, args, options = {}) {
  try {
    return execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: options.encoding ?? "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString("utf8").trim();
    throw new ProductionAuthorizationError(
      `git ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`
    );
  }
}

function gitSucceeds(repositoryRoot, args) {
  return (
    spawnSync("git", ["-C", repositoryRoot, ...args], {
      stdio: "ignore",
    }).status === 0
  );
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new ProductionAuthorizationError(
      `Could not read ${description}: ${error.message}`
    );
  }
}

function repositoryApiPath(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new ProductionAuthorizationError(
      `Invalid GITHUB_REPOSITORY '${repository}'.`
    );
  }
  return parts.map(encodeURIComponent).join("/");
}

async function fetchJson(url, { token, description }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "User-Agent": "vgpu-production-authorization",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
    headers["X-GitHub-Api-Version"] = "2026-03-10";
  }

  let response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    throw new ProductionAuthorizationError(
      `${description} failed: ${error.message}`
    );
  }

  if (!response.ok) {
    throw new ProductionAuthorizationError(
      `${description} failed (${response.status}): ${await response.text()}`
    );
  }

  return response.json();
}

function githubClient(repository, token) {
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const graphqlUrl = process.env.GITHUB_GRAPHQL_URL ?? `${apiUrl}/graphql`;
  const repoPath = repositoryApiPath(repository);

  return {
    get(path, description) {
      return fetchJson(`${apiUrl}/repos/${repoPath}${path}`, {
        token,
        description,
      });
    },
    async graphql(query, variables, description) {
      const response = await fetch(graphqlUrl, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "vgpu-production-authorization",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(20_000),
      });
      const payload = await response.json();
      if (!response.ok || payload.errors?.length) {
        throw new ProductionAuthorizationError(
          `${description} failed (${response.status}): ${JSON.stringify(
            payload.errors ?? payload
          )}`
        );
      }
      return payload.data;
    },
    async post(path, body, description) {
      const url = `${apiUrl}/repos/${repoPath}${path}`;
      const response = await fetch(url, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "User-Agent": "vgpu-production-authorization",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        throw new ProductionAuthorizationError(
          `${description} failed (${response.status}): ${await response.text()}`
        );
      }

      return response.json();
    },
  };
}

async function githubPaginated(github, path, property, description) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const response = await github.get(
      `${path}${separator}per_page=100&page=${page}`,
      `${description} (page ${page})`
    );
    const pageItems = response?.[property];
    if (!Array.isArray(pageItems)) {
      throw new ProductionAuthorizationError(
        `${description} returned an invalid '${property}' collection.`
      );
    }
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}

async function currentBranchSha(github, branch) {
  const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
  const ref = await github.get(
    `/git/ref/heads/${encodedBranch}`,
    `Reading the current ${branch} ref`
  );
  return ref.object?.sha ?? null;
}

async function postAuthorizationStatus(
  github,
  sha,
  state,
  description,
  targetUrl
) {
  const safeDescription = String(description)
    .replace(/[\u0000-\u001f\u007f%]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
  await github.post(
    `/statuses/${encodeURIComponent(sha)}`,
    {
      state,
      context: PRODUCTION_AUTHORIZATION_CONTEXT,
      description: safeDescription,
      target_url: targetUrl,
    },
    `Posting ${state} production authorization status`
  );
}

function commitParents(repositoryRoot, sha) {
  const fields = git(repositoryRoot, ["rev-list", "--parents", "-n", "1", sha])
    .trim()
    .split(/\s+/);
  if (fields[0] !== sha) {
    throw new ProductionAuthorizationError(
      `Candidate checkout does not contain commit ${sha}.`
    );
  }
  return fields.slice(1);
}

function changedPaths(repositoryRoot, parentSha, candidateSha) {
  const output = git(
    repositoryRoot,
    [
      "diff",
      "--name-only",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "-z",
      parentSha,
      candidateSha,
    ],
    { encoding: "buffer" }
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function collectWorkspaceManifests(repositoryRoot) {
  const manifests = [];
  for (const workspaceRoot of ["packages", "examples", "apps"]) {
    const absoluteRoot = resolve(repositoryRoot, workspaceRoot);
    if (!existsSync(absoluteRoot)) continue;
    for (const entry of readdirSync(absoluteRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifestPath = `${workspaceRoot}/${entry.name}/package.json`;
      const absoluteManifestPath = resolve(repositoryRoot, manifestPath);
      if (!existsSync(absoluteManifestPath)) continue;
      manifests.push({
        manifestPath,
        manifest: readJson(absoluteManifestPath, manifestPath),
      });
    }
  }
  return manifests;
}

function releasePackageVersionErrors(repositoryRoot, expectedVersion) {
  const config = readJson(
    resolve(repositoryRoot, ".changeset/config.json"),
    ".changeset/config.json"
  );
  if (!Array.isArray(config.fixed)) {
    throw new ProductionAuthorizationError(
      ".changeset/config.json must define fixed package groups."
    );
  }
  return validateReleasePackageVersions({
    configuredFixedPackageNames: config.fixed.flat(),
    manifests: collectWorkspaceManifests(repositoryRoot),
    expectedVersion,
  });
}

function candidateMatchesTrustedFiles(candidateRoot, trustedRoot, paths) {
  try {
    return paths.every((path) => {
      const candidatePath = resolve(candidateRoot, path);
      const trustedPath = resolve(trustedRoot, path);
      const candidateStat = lstatSync(candidatePath);
      const trustedStat = lstatSync(trustedPath);
      return (
        candidateStat.isFile() &&
        !candidateStat.isSymbolicLink() &&
        trustedStat.isFile() &&
        !trustedStat.isSymbolicLink() &&
        readFileSync(candidatePath).equals(readFileSync(trustedPath))
      );
    });
  } catch {
    return false;
  }
}

async function inspectMainPolicyRevision({
  github,
  policySha,
  trustedPolicySha,
  trustedRoot,
}) {
  const trustedFilesAreRegular = MAIN_POLICY_PATHS.every((path) => {
    try {
      const stat = lstatSync(resolve(trustedRoot, path));
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!trustedFilesAreRegular) {
    throw new ProductionAuthorizationError(
      "Current trusted main-policy files must be regular files."
    );
  }

  if (policySha === trustedPolicySha) {
    return { isAncestor: true, matchesTrusted: true };
  }

  const comparison = await github.get(
    `/compare/${encodeURIComponent(policySha)}...${encodeURIComponent(
      trustedPolicySha
    )}`,
    `Comparing main-policy revision ${policySha} with trusted policy ${trustedPolicySha}`
  );
  const isAncestor =
    comparison?.merge_base_commit?.sha === policySha &&
    (comparison.status === "ahead" || comparison.status === "identical");
  if (!isAncestor) return { isAncestor: false, matchesTrusted: false };

  const matches = await Promise.all(
    MAIN_POLICY_PATHS.map(async (path) => {
      const encodedPath = path.split("/").map(encodeURIComponent).join("/");
      const payload = await github.get(
        `/contents/${encodedPath}?ref=${encodeURIComponent(policySha)}`,
        `Reading ${path} at main-policy revision ${policySha}`
      );
      if (
        payload?.type !== "file" ||
        payload.encoding !== "base64" ||
        typeof payload.content !== "string"
      ) {
        return false;
      }
      const historical = Buffer.from(
        payload.content.replaceAll("\n", ""),
        "base64"
      );
      return historical.equals(readFileSync(resolve(trustedRoot, path)));
    })
  );
  return { isAncestor: true, matchesTrusted: matches.every(Boolean) };
}

async function npmPublicationEvidence(version) {
  return Promise.all(
    PUBLISHED_PACKAGES.map(async (name) => {
      const packument = await fetchJson(
        `https://registry.npmjs.org/${encodeURIComponent(name)}`,
        { description: `Reading npm metadata for ${name}` }
      );
      return {
        name,
        versionExists: packument.versions?.[version]?.version === version,
        latest: packument["dist-tags"]?.latest ?? null,
      };
    })
  );
}

async function main() {
  const repositoryRoot = resolve(process.argv[2] ?? ".");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const token = requiredEnvironment("GITHUB_TOKEN");
  const currentRunId = requiredEnvironment("GITHUB_RUN_ID");
  const trustedPolicySha = requireSha(
    requiredEnvironment("GITHUB_WORKFLOW_SHA"),
    "Trusted policy SHA"
  );
  const runUrl = `${requiredEnvironment(
    "GITHUB_SERVER_URL"
  )}/${repository}/actions/runs/${currentRunId}`;
  const github = githubClient(repository, token);
  const workflowRunId = requiredEnvironment("CI_WORKFLOW_RUN_ID");
  const event = {
    id: workflowRunId,
    workflowId: Number(requiredEnvironment("CI_WORKFLOW_ID")),
    path: requiredEnvironment("CI_WORKFLOW_PATH"),
    triggeringEvent: requiredEnvironment("CI_WORKFLOW_EVENT"),
    status: requiredEnvironment("CI_WORKFLOW_STATUS"),
    conclusion: requiredEnvironment("CI_WORKFLOW_CONCLUSION"),
    headBranch: requiredEnvironment("CI_HEAD_BRANCH"),
    headSha: requiredEnvironment("CI_HEAD_SHA"),
    headRepository: requiredEnvironment("CI_HEAD_REPOSITORY"),
  };
  const ciRun = await github.get(
    `/actions/runs/${encodeURIComponent(workflowRunId)}`,
    `Reading CI workflow run ${workflowRunId}`
  );
  const candidateSha = validateCiWorkflowRun({ event, run: ciRun, repository });
  const currentAuthorizationRun = await github.get(
    `/actions/runs/${encodeURIComponent(currentRunId)}`,
    `Reading current production-authorization run ${currentRunId}`
  );
  const authorizationWorkflowId = validateProductionAuthorizationWorkflowRun({
    run: currentAuthorizationRun,
    repository,
    authorizedSha: candidateSha,
    requireSuccess: false,
  });
  if (currentAuthorizationRun.head_sha !== trustedPolicySha) {
    throw new ProductionAuthorizationError(
      `Production-authorization run policy ${
        currentAuthorizationRun.head_sha ?? "unknown"
      } does not match GITHUB_WORKFLOW_SHA ${trustedPolicySha}.`
    );
  }
  const ciJobs = await githubPaginated(
    github,
    `/actions/runs/${encodeURIComponent(workflowRunId)}/jobs?filter=all`,
    "jobs",
    `Reading jobs for CI workflow run ${workflowRunId}`
  );
  validateCiWorkflowJobs(ciJobs);
  statusCandidateSha = candidateSha;

  const checkedOutSha = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (checkedOutSha !== candidateSha) {
    throw new ProductionAuthorizationError(
      `Candidate checkout is ${checkedOutSha}, but CI validated ${candidateSha}.`
    );
  }

  const initialMainSha = await currentBranchSha(github, "main");
  requireCurrentMainTip({
    candidateSha,
    currentMainSha: initialMainSha,
    phase: "before policy evaluation",
  });

  const candidateStatuses = await github.get(
    `/commits/${encodeURIComponent(candidateSha)}/statuses?per_page=100`,
    `Reading existing production authorization status on ${candidateSha}`
  );
  const existingAuthorization = latestCommitStatus(
    candidateStatuses,
    PRODUCTION_AUTHORIZATION_CONTEXT
  );
  let alreadyAuthorized = false;
  if (existingAuthorization?.state === "success") {
    const inspection = await inspectExistingProductionAuthorization({
      status: existingAuthorization,
      repository,
      authorizedSha: candidateSha,
      authorizationWorkflowId,
      readRun: (runId) =>
        github.get(
          `/actions/runs/${encodeURIComponent(runId)}`,
          `Reading existing production-authorization run ${runId}`
        ),
    });
    if (inspection.canonical) {
      alreadyAuthorized = true;
    } else {
      console.log(
        `Ignoring an unauthenticated prior success on ${candidateSha}: ${inspection.reason}`
      );
    }
  }
  if (alreadyAuthorized) {
    console.log(
      `${candidateSha} already has a successful '${PRODUCTION_AUTHORIZATION_CONTEXT}' status; revalidating without downgrading it.`
    );
  } else {
    await postAuthorizationStatus(
      github,
      candidateSha,
      "pending",
      "Validating stable promotion or web-only production policy.",
      runUrl
    );
    statusStarted = true;
  }

  const parents = commitParents(repositoryRoot, candidateSha);
  if (parents.length === 0) {
    throw new ProductionAuthorizationError(
      "The candidate main commit has no first parent."
    );
  }
  const firstParentSha = parents[0];
  const statuses = await github.get(
    `/commits/${encodeURIComponent(firstParentSha)}/statuses?per_page=100`,
    `Reading production authorization status on ${firstParentSha}`
  );
  const parentProductionStatus = latestCommitStatus(
    statuses,
    PRODUCTION_AUTHORIZATION_CONTEXT
  );
  const parentAuthorizationRunId = parentProductionStatus
    ? releaseRunIdFromStatusTarget(
        parentProductionStatus.target_url,
        repository
      )
    : null;
  const parentAuthorizationRun = parentAuthorizationRunId
    ? await github.get(
        `/actions/runs/${encodeURIComponent(parentAuthorizationRunId)}`,
        `Reading first-parent authorization run ${parentAuthorizationRunId}`
      )
    : null;
  const associatedPullRequests = await github.get(
    `/commits/${encodeURIComponent(candidateSha)}/pulls?per_page=100`,
    `Reading PR associated with ${candidateSha}`
  );
  if (
    !Array.isArray(associatedPullRequests) ||
    associatedPullRequests.length !== 1
  ) {
    throw new ProductionAuthorizationError(
      `Expected exactly one PR associated with ${candidateSha}; found ${
        Array.isArray(associatedPullRequests)
          ? associatedPullRequests.length
          : "invalid data"
      }.`
    );
  }
  const pullRequestNumber = associatedPullRequests[0]?.number;
  if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber <= 0) {
    throw new ProductionAuthorizationError(
      `GitHub returned an invalid associated PR number '${pullRequestNumber}'.`
    );
  }
  const [owner, name] = repository.split("/");
  const pullRequestData = await github.graphql(
    `query ProductionAuthorizationPullRequest($owner: String!, $name: String!, $number: Int!) {
      repository(owner: $owner, name: $name) {
        pullRequest(number: $number) {
          number
          state
          merged
          mergedAt
          mergeCommit { oid }
          baseRefName
          baseRefOid
          headRefName
          headRefOid
          headRepository { nameWithOwner }
        }
      }
    }`,
    { owner, name, number: pullRequestNumber },
    `Reading canonical GraphQL data for PR #${pullRequestNumber}`
  );
  const pullRequest = normalizeGraphqlPullRequest(
    pullRequestData?.repository?.pullRequest
  );
  const pullRequests = [pullRequest];
  const pullRequestHeadSha = pullRequest?.head?.sha;
  const checkRuns = pullRequestHeadSha
    ? (
        await github.get(
          `/commits/${encodeURIComponent(
            pullRequestHeadSha
          )}/check-runs?check_name=main-policy&filter=latest&per_page=100`,
          `Reading main-policy check on ${pullRequestHeadSha}`
        )
      ).check_runs
    : [];
  const latestMainPolicy = latestMainPolicyCheck(checkRuns);
  const mainPolicyBinding = parseMainPolicyCheckExternalId(
    latestMainPolicy?.external_id
  );
  const mainPolicyPolicySha = mainPolicyBinding?.policySha ?? null;
  const mainPolicyRunId = latestMainPolicy
    ? mainPolicyRunIdFromDetailsUrl(latestMainPolicy.details_url, repository)
    : null;
  const mainPolicyWorkflowRun = mainPolicyRunId
    ? await github.get(
        `/actions/runs/${encodeURIComponent(mainPolicyRunId)}`,
        `Reading main-policy workflow run ${mainPolicyRunId}`
      )
    : null;
  const baseHasMainPolicy = gitSucceeds(repositoryRoot, [
    "cat-file",
    "-e",
    `${firstParentSha}:.github/workflows/main-policy.yml`,
  ]);
  const trustedRepositoryRoot = resolve(import.meta.dirname, "..");
  const candidateHasMainPolicy = candidateMatchesTrustedFiles(
    repositoryRoot,
    trustedRepositoryRoot,
    MAIN_POLICY_PATHS
  );
  const mainPolicyRevision =
    mainPolicyPolicySha === null
      ? { isAncestor: false, matchesTrusted: false }
      : await inspectMainPolicyRevision({
          github,
          policySha: mainPolicyPolicySha,
          trustedPolicySha,
          trustedRoot: trustedRepositoryRoot,
        });

  const headRef = pullRequest?.head?.ref ?? "";
  const version = promotionVersionFromBranch(headRef);
  let stableEvidence = {
    npmEvidence: [],
    packageVersionErrors: [],
    parentIsTagAncestor: false,
    release: null,
    releaseJobs: [],
    releaseRun: null,
    stableNpmAuditStatus: null,
    tagIsInCanary: false,
    tagSha: null,
    tagTreeSha: null,
  };
  let stableRefSnapshot = null;

  if (version !== null) {
    const tag = `v${version}`;
    const tagRef = `refs/tags/${tag}`;
    // Refresh the tag even when checkout fetched it, so a moved remote tag cannot be authorized
    // from stale local state.
    git(repositoryRoot, ["fetch", "--force", "origin", `${tagRef}:${tagRef}`]);
    const tagSha = git(repositoryRoot, [
      "rev-parse",
      `${tagRef}^{commit}`,
    ]).trim();
    const canarySha = await currentBranchSha(github, "canary");
    requireSha(canarySha, "Current canary SHA");
    if (
      !gitSucceeds(repositoryRoot, ["cat-file", "-e", `${canarySha}^{commit}`])
    ) {
      git(repositoryRoot, ["fetch", "--no-tags", "origin", canarySha]);
    }
    const tagStatuses = await github.get(
      `/commits/${encodeURIComponent(tagSha)}/statuses?per_page=100`,
      `Reading stable npm audit status on ${tagSha}`
    );
    const stableNpmAuditStatus = latestCommitStatus(
      tagStatuses,
      STABLE_NPM_AUDIT_CONTEXT
    );
    const releaseRunId = stableNpmAuditStatus
      ? releaseRunIdFromStatusTarget(
          stableNpmAuditStatus.target_url,
          repository
        )
      : null;
    const releaseRun = releaseRunId
      ? await github.get(
          `/actions/runs/${encodeURIComponent(releaseRunId)}`,
          `Reading stable Release run ${releaseRunId}`
        )
      : null;
    const releaseJobs = releaseRunId
      ? await githubPaginated(
          github,
          `/actions/runs/${encodeURIComponent(releaseRunId)}/jobs?filter=all`,
          "jobs",
          `Reading jobs for stable Release run ${releaseRunId}`
        )
      : [];
    let release = null;
    try {
      release = await github.get(
        `/releases/tags/${encodeURIComponent(tag)}`,
        `Reading GitHub Release ${tag}`
      );
    } catch (error) {
      if (!String(error.message).includes("failed (404)")) throw error;
    }

    stableEvidence = {
      npmEvidence: await npmPublicationEvidence(version),
      packageVersionErrors: releasePackageVersionErrors(
        repositoryRoot,
        version
      ),
      parentIsTagAncestor: gitSucceeds(repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        firstParentSha,
        tagSha,
      ]),
      release,
      releaseJobs,
      releaseRun,
      stableNpmAuditStatus,
      tagIsInCanary: gitSucceeds(repositoryRoot, [
        "merge-base",
        "--is-ancestor",
        tagSha,
        canarySha,
      ]),
      tagSha,
      tagTreeSha: git(repositoryRoot, ["rev-parse", `${tagSha}^{tree}`]).trim(),
    };
    stableRefSnapshot = { tag, tagSha, canarySha };
  }

  const result = evaluateProductionAuthorization({
    authorizationWorkflowId,
    baseHasMainPolicy,
    candidateHasMainPolicy,
    candidateSha,
    candidateTreeSha: git(repositoryRoot, [
      "rev-parse",
      `${candidateSha}^{tree}`,
    ]).trim(),
    changedPaths: changedPaths(repositoryRoot, firstParentSha, candidateSha),
    checkRuns,
    mainPolicyWorkflowRun,
    mainPolicyPolicyIsAncestor: mainPolicyRevision.isAncestor,
    mainPolicyPolicyMatchesTrusted: mainPolicyRevision.matchesTrusted,
    mainPolicyPolicySha,
    parentAuthorizationRun,
    parentProductionStatus,
    parents,
    pullRequests,
    repository,
    trustedPolicySha,
    ...stableEvidence,
  });

  if (result.kind === "stable") {
    const [currentTagCommit, currentCanarySha] = await Promise.all([
      github.get(
        `/commits/refs%2Ftags%2F${encodeURIComponent(stableRefSnapshot.tag)}`,
        `Re-reading ${stableRefSnapshot.tag} before production authorization`
      ),
      currentBranchSha(github, "canary"),
    ]);
    requireUnchangedStableRefs({
      tag: stableRefSnapshot.tag,
      expectedTagSha: stableRefSnapshot.tagSha,
      currentTagSha: currentTagCommit?.sha,
      expectedCanarySha: stableRefSnapshot.canarySha,
      currentCanarySha,
    });
  }

  const finalMainSha = await currentBranchSha(github, "main");
  requireCurrentMainTip({
    candidateSha,
    currentMainSha: finalMainSha,
    phase: "during policy evaluation",
  });

  successWriteAttempted = true;
  try {
    await postAuthorizationStatus(
      github,
      candidateSha,
      "success",
      result.kind === "stable"
        ? `${result.tag} is published and main matches its tree.`
        : `Web-only PR #${result.pullRequestNumber} changes only apps/docs/**.`,
      runUrl
    );
  } catch (writeError) {
    // GitHub may accept a status even if its response is lost. Confirm the latest write before
    // failing the run; the outer handler deliberately never posts failure after an ambiguous
    // success attempt.
    const confirmationStatuses = await github.get(
      `/commits/${encodeURIComponent(candidateSha)}/statuses?per_page=100`,
      `Confirming production authorization success on ${candidateSha}`
    );
    const confirmation = latestCommitStatus(
      confirmationStatuses,
      PRODUCTION_AUTHORIZATION_CONTEXT
    );
    if (
      !confirmsProductionAuthorizationWrite({
        status: confirmation,
        targetUrl: runUrl,
      })
    ) {
      throw writeError;
    }
    console.log(
      `Confirmed '${PRODUCTION_AUTHORIZATION_CONTEXT}' after its API response was interrupted.`
    );
  }
  console.log(result.message);
  if (result.bootstrap) {
    console.log(
      `Used the one-time main-policy bootstrap exception for parent ${firstParentSha}.`
    );
  }
}

let statusCandidateSha = null;
let statusStarted = false;
let successWriteAttempted = false;

main()
  .then(() => {
    statusStarted = false;
    successWriteAttempted = false;
  })
  .catch(async (error) => {
    const message = error instanceof Error ? error.message : String(error);
    // A failure before the initial tip check leaves the context absent; a stale commit is left
    // pending and cannot authorize either it or the newer main deployment.
    try {
      if (statusStarted && !successWriteAttempted) {
        const repository = requiredEnvironment("GITHUB_REPOSITORY");
        const github = githubClient(
          repository,
          requiredEnvironment("GITHUB_TOKEN")
        );
        const currentMainSha = await currentBranchSha(github, "main");
        if (currentMainSha === statusCandidateSha) {
          const runUrl = `${requiredEnvironment(
            "GITHUB_SERVER_URL"
          )}/${repository}/actions/runs/${requiredEnvironment(
            "GITHUB_RUN_ID"
          )}`;
          await postAuthorizationStatus(
            github,
            statusCandidateSha,
            "failure",
            `Production policy rejected this commit: ${message}`,
            runUrl
          );
        }
      }
    } catch (statusError) {
      const safeStatusError = String(statusError.message).replace(
        /[\r\n%]+/g,
        " "
      );
      console.error(`Could not report policy failure: ${safeStatusError}`);
    }

    console.error(
      `production-authorization: ${message.replace(/[\r\n%]+/g, " ")}`
    );
    process.exitCode = 1;
  });
