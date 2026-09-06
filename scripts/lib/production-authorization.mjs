export const CI_WORKFLOW_ID = 272180435;
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
export const RELEASE_WORKFLOW_ID = 272860864;
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const GITHUB_ACTIONS_APP_ID = 15368;
export const CONTROL_PLANE_BRANCH = "canary";
export const MAIN_POLICY_CHECK = "main-policy";
export const MAIN_POLICY_WORKFLOW_PATH = ".github/workflows/main-policy.yml";
export const PRODUCTION_AUTHORIZATION_WORKFLOW_PATH =
  ".github/workflows/production-authorization.yml";
export const PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX =
  "Production authorization for";
export const STABLE_NPM_AUDIT_CONTEXT = "vgpu: stable npm published";
export const PRODUCTION_AUTHORIZATION_CONTEXT =
  "Vercel - vgpu: production authorized";
export const BOOTSTRAP_MAIN_SHA = "e1661e3385ac63dc88535c1a0e819e52702f02f8";

export const PUBLISHED_PACKAGES = Object.freeze([
  "vgpu",
  "@vgpu/core",
  "@vgpu/wgsl",
  "@vgpu/wgsl-std",
  "@vgpu/adapter-node",
  "@vgpu/adapter-mock",
  "@vgpu/render",
]);

export const CI_REQUIRED_JOBS = Object.freeze([
  "test-fast",
  "docker-gpu",
  "docs-app-build",
  "docs-generated",
  "examples-api-generated",
  "examples-windows-online",
  "wgsl-cachekey-determinism (macos-14)",
  "wgsl-cachekey-determinism (ubuntu-24.04)",
  "wgsl-cachekey-determinism (ubuntu-24.04-arm)",
  "wgsl-loader-bundler-tests",
  "wgsl-turbopack-smoke",
  "docs-parity",
]);

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const STABLE_VERSION =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const PROMOTION_BRANCH = new RegExp(`^promote/v(${STABLE_VERSION})$`);
const SITE_BRANCH = /^site\/.+/;

export class ProductionAuthorizationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProductionAuthorizationError";
  }
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new ProductionAuthorizationError(message);
  }
}

function numericId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function newestById(items) {
  return [...items].sort((left, right) => {
    const leftId = numericId(left.id) ?? 0;
    const rightId = numericId(right.id) ?? 0;
    return rightId - leftId;
  })[0];
}

export function requireSha(value, description) {
  requireCondition(
    typeof value === "string" && SHA_PATTERN.test(value),
    `${description} must be a full 40-character Git SHA.`
  );
  return value;
}

export function requireCurrentMainTip({ candidateSha, currentMainSha, phase }) {
  requireSha(candidateSha, "Candidate SHA");
  requireSha(currentMainSha, "Current main SHA");
  requireCondition(
    candidateSha === currentMainSha,
    `main moved ${phase}: CI validated ${candidateSha}, but the current tip is ${currentMainSha}.`
  );
}

export function requireUnchangedStableRefs({
  tag,
  expectedTagSha,
  currentTagSha,
  expectedCanarySha,
  currentCanarySha,
}) {
  requireSha(expectedTagSha, `Initial ${tag} SHA`);
  requireSha(currentTagSha, `Current ${tag} SHA`);
  requireSha(expectedCanarySha, "Initial canary SHA");
  requireSha(currentCanarySha, "Current canary SHA");
  requireCondition(
    currentTagSha === expectedTagSha,
    `${tag} moved during policy evaluation: expected ${expectedTagSha}, current ${currentTagSha}.`
  );
  requireCondition(
    currentCanarySha === expectedCanarySha,
    `canary moved during policy evaluation: expected ${expectedCanarySha}, current ${currentCanarySha}.`
  );
}

export function validateProductionAuthorizationWorkflowRun({
  run,
  repository,
  authorizedSha,
  requireSuccess,
}) {
  requireCondition(
    run !== null && typeof run === "object",
    "GitHub returned invalid production-authorization run data."
  );
  requireSha(authorizedSha, "Authorized SHA");
  requireCondition(
    numericId(run.workflow_id) !== null &&
      run.path === PRODUCTION_AUTHORIZATION_WORKFLOW_PATH &&
      run.event === "workflow_run" &&
      run.head_branch === CONTROL_PLANE_BRANCH &&
      run.head_repository?.full_name === repository &&
      run.display_title ===
        `${PRODUCTION_AUTHORIZATION_RUN_NAME_PREFIX} ${authorizedSha}`,
    `Production authorization must come from ${PRODUCTION_AUTHORIZATION_WORKFLOW_PATH} for ${authorizedSha} in ${repository}.`
  );
  if (requireSuccess) {
    requireCondition(
      run.status === "completed" && run.conclusion === "success",
      `Production-authorization run ${
        run.id ?? "unknown"
      } must be completed successfully.`
    );
  }
  return run.workflow_id;
}

export function validateCiWorkflowRun({ event, run, repository }) {
  requireCondition(
    event !== null && typeof event === "object",
    "Missing workflow_run event data."
  );
  requireCondition(
    run !== null && typeof run === "object",
    "GitHub returned invalid CI run data."
  );
  requireCondition(
    String(run.id) === String(event.id),
    `CI run ID mismatch: event ${event.id}, API ${run.id}.`
  );
  requireCondition(
    run.workflow_id === CI_WORKFLOW_ID && event.workflowId === CI_WORKFLOW_ID,
    `Production authorization requires CI workflow ID ${CI_WORKFLOW_ID}.`
  );
  requireCondition(
    run.path === CI_WORKFLOW_PATH && event.path === CI_WORKFLOW_PATH,
    `Production authorization requires workflow path ${CI_WORKFLOW_PATH}.`
  );
  requireCondition(
    run.event === "push" && event.triggeringEvent === "push",
    "Production authorization only accepts CI runs triggered by a push."
  );
  requireCondition(
    run.status === "completed" && event.status === "completed",
    "The triggering CI run must be completed."
  );
  requireCondition(
    run.conclusion === "success" && event.conclusion === "success",
    "The triggering CI run must have succeeded."
  );
  requireCondition(
    run.head_branch === "main" && event.headBranch === "main",
    "Production authorization only accepts CI runs for main."
  );
  requireSha(run.head_sha, "CI API head SHA");
  requireSha(event.headSha, "CI event head SHA");
  requireCondition(
    run.head_sha === event.headSha,
    `CI head SHA mismatch: event ${event.headSha}, API ${run.head_sha}.`
  );
  requireCondition(
    run.head_repository?.full_name === repository &&
      event.headRepository === repository,
    `The triggering CI run must belong to ${repository}.`
  );

  return run.head_sha;
}

export function validateCiWorkflowJobs(jobs) {
  requireCondition(Array.isArray(jobs), "GitHub returned invalid CI job data.");
  for (const expectedName of CI_REQUIRED_JOBS) {
    const successful = jobs.some(
      (job) =>
        job.name === expectedName &&
        job.status === "completed" &&
        job.conclusion === "success"
    );
    requireCondition(
      successful,
      `The triggering CI run has no completed, successful '${expectedName}' job.`
    );
  }
}

export function selectCiPushRunForRelease({
  runs,
  repository,
  releaseBranch,
  releaseSha,
}) {
  requireCondition(
    Array.isArray(runs),
    "GitHub returned invalid CI workflow-run data."
  );
  requireSha(releaseSha, "Release SHA");

  const latest = newestById(
    runs.filter(
      (run) =>
        run.workflow_id === CI_WORKFLOW_ID &&
        run.path === CI_WORKFLOW_PATH &&
        run.event === "push" &&
        run.head_branch === releaseBranch &&
        run.head_sha === releaseSha &&
        run.head_repository?.full_name === repository
    )
  );
  requireCondition(
    latest,
    `No canonical CI push run found for ${releaseBranch} at ${releaseSha}. Wait for push CI before publishing.`
  );
  requireCondition(
    latest.status === "completed" && latest.conclusion === "success",
    `Latest CI push run ${latest.id} for ${releaseSha} is ${latest.status}/${latest.conclusion}, expected completed/success.`
  );
  return latest;
}

export function latestCommitStatus(statuses, context) {
  requireCondition(
    Array.isArray(statuses),
    "GitHub returned invalid commit status data."
  );
  return (
    newestById(statuses.filter((status) => status.context === context)) ?? null
  );
}

export function isAlreadyProductionAuthorized(statuses) {
  return (
    latestCommitStatus(statuses, PRODUCTION_AUTHORIZATION_CONTEXT)?.state ===
    "success"
  );
}

export function confirmsProductionAuthorizationWrite({ status, targetUrl }) {
  return (
    status?.context === PRODUCTION_AUTHORIZATION_CONTEXT &&
    status.state === "success" &&
    status.target_url === targetUrl &&
    status.creator?.login === "github-actions[bot]"
  );
}

export function latestMainPolicyCheck(checkRuns) {
  requireCondition(
    Array.isArray(checkRuns),
    "GitHub returned invalid main-policy check data."
  );
  return (
    newestById(
      checkRuns.filter((checkRun) => checkRun.name === MAIN_POLICY_CHECK)
    ) ?? null
  );
}

export function mainPolicyRunIdFromDetailsUrl(detailsUrl, repository) {
  try {
    const url = new URL(detailsUrl);
    const path = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    const [owner, name] = repository.split("/");
    if (
      url.origin !== "https://github.com" ||
      url.search !== "" ||
      url.hash !== "" ||
      path.length !== 5 ||
      path[0] !== owner ||
      path[1] !== name ||
      path[2] !== "actions" ||
      path[3] !== "runs" ||
      !/^[1-9][0-9]*$/.test(path[4])
    ) {
      return null;
    }
    return path[4];
  } catch {
    return null;
  }
}

export function mainPolicyRunName(pullRequest) {
  return `Main policy PR #${pullRequest.number}: ${pullRequest.base.sha} -> ${pullRequest.head.sha}`;
}

export function mainPolicyCheckExternalId({
  workflowRun,
  pullRequest,
  policySha,
}) {
  return [
    MAIN_POLICY_CHECK,
    workflowRun.id,
    workflowRun.run_attempt,
    policySha,
    pullRequest.number,
    pullRequest.base.sha,
    pullRequest.head.sha,
  ].join(":");
}

export function parseMainPolicyCheckExternalId(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(":");
  if (
    parts.length !== 7 ||
    parts[0] !== MAIN_POLICY_CHECK ||
    !/^[1-9][0-9]*$/.test(parts[1]) ||
    !/^[1-9][0-9]*$/.test(parts[2]) ||
    !SHA_PATTERN.test(parts[3]) ||
    !/^[1-9][0-9]*$/.test(parts[4]) ||
    !SHA_PATTERN.test(parts[5]) ||
    !SHA_PATTERN.test(parts[6])
  ) {
    return null;
  }
  return {
    runId: parts[1],
    runAttempt: parts[2],
    policySha: parts[3],
    pullRequestNumber: parts[4],
    baseSha: parts[5],
    headSha: parts[6],
  };
}

export function promotionVersionFromBranch(headRef) {
  return PROMOTION_BRANCH.exec(headRef)?.[1] ?? null;
}

export function normalizeGraphqlPullRequest(pullRequest) {
  requireCondition(
    pullRequest !== null && typeof pullRequest === "object",
    "GitHub GraphQL returned invalid PR data."
  );

  return {
    number: pullRequest.number,
    state:
      pullRequest.merged === true ? "closed" : pullRequest.state?.toLowerCase(),
    merged_at: pullRequest.mergedAt ?? null,
    merge_commit_sha: pullRequest.mergeCommit?.oid ?? null,
    base: {
      ref: pullRequest.baseRefName ?? null,
      sha: pullRequest.baseRefOid ?? null,
    },
    head: {
      ref: pullRequest.headRefName ?? null,
      sha: pullRequest.headRefOid ?? null,
      repo: {
        full_name: pullRequest.headRepository?.nameWithOwner ?? null,
      },
    },
  };
}

export function selectAssociatedPullRequest({
  candidateSha,
  pullRequests,
  repository,
  firstParentSha,
  parents,
}) {
  requireCondition(
    Array.isArray(pullRequests),
    "GitHub returned invalid associated PR data."
  );
  requireCondition(Array.isArray(parents), "Invalid candidate parent data.");
  requireCondition(
    parents.length === 2,
    `The main commit must be a two-parent PR merge commit; received ${parents.length} parent(s).`
  );

  const matches = pullRequests.filter(
    (pullRequest) =>
      pullRequest.state === "closed" &&
      Boolean(pullRequest.merged_at) &&
      pullRequest.base?.ref === "main"
  );

  requireCondition(
    matches.length === 1,
    `Expected exactly one merged PR into main for this commit; found ${matches.length}.`
  );

  const pullRequest = matches[0];
  requireCondition(
    pullRequest.head?.repo?.full_name === repository,
    `The main PR must use a branch in ${repository}, not a fork.`
  );
  requireCondition(
    pullRequest.merge_commit_sha === candidateSha,
    `PR #${pullRequest.number} merge commit is ${
      pullRequest.merge_commit_sha ?? "unknown"
    }, expected ${candidateSha}.`
  );
  requireCondition(
    pullRequest.base?.sha === firstParentSha,
    `PR #${pullRequest.number} was based on ${
      pullRequest.base?.sha ?? "an unknown SHA"
    }, but the main commit's first parent is ${firstParentSha}.`
  );
  requireSha(pullRequest.head?.sha, `PR #${pullRequest.number} head SHA`);

  requireCondition(
    parents[1] === pullRequest.head.sha,
    `The merge commit's second parent ${parents[1]} does not match PR #${pullRequest.number} head ${pullRequest.head.sha}.`
  );

  return pullRequest;
}

export function releaseRunIdFromStatusTarget(targetUrl, repository) {
  try {
    const url = new URL(targetUrl);
    const path = url.pathname.replace(/\/$/, "").split("/").filter(Boolean);
    const [owner, name] = repository.split("/");
    if (
      url.origin !== "https://github.com" ||
      url.search !== "" ||
      url.hash !== "" ||
      path.length !== 5 ||
      path[0] !== owner ||
      path[1] !== name ||
      path[2] !== "actions" ||
      path[3] !== "runs" ||
      !/^[1-9][0-9]*$/.test(path[4])
    ) {
      return null;
    }
    return path[4];
  } catch {
    return null;
  }
}

export function validateCanonicalProductionAuthorizationStatus({
  status,
  run,
  repository,
  authorizedSha,
  authorizationWorkflowId,
}) {
  requireCondition(
    status !== null && typeof status === "object",
    `Commit ${authorizedSha} has no production-authorization status.`
  );
  requireCondition(
    status.context === PRODUCTION_AUTHORIZATION_CONTEXT &&
      status.state === "success" &&
      status.creator?.login === "github-actions[bot]",
    `Production authorization on ${authorizedSha} is not a canonical success from github-actions[bot].`
  );
  const runId = releaseRunIdFromStatusTarget(status.target_url, repository);
  requireCondition(
    runId !== null && String(run?.id) === runId,
    `Production authorization on ${authorizedSha} must link to its exact GitHub Actions run.`
  );
  const workflowId = validateProductionAuthorizationWorkflowRun({
    run,
    repository,
    authorizedSha,
    requireSuccess: true,
  });
  requireCondition(
    workflowId === authorizationWorkflowId,
    `Production authorization on ${authorizedSha} used workflow ID ${workflowId}, expected ${authorizationWorkflowId}.`
  );
}

export async function inspectExistingProductionAuthorization({
  status,
  repository,
  authorizedSha,
  authorizationWorkflowId,
  readRun,
}) {
  const runId = releaseRunIdFromStatusTarget(status?.target_url, repository);
  // Keep transport failures outside the validation catch. If GitHub cannot prove what the linked
  // run is, the caller must stop without replacing a previously successful status.
  const run = runId === null ? null : await readRun(runId);

  try {
    validateCanonicalProductionAuthorizationStatus({
      status,
      run,
      repository,
      authorizedSha,
      authorizationWorkflowId,
    });
    return { canonical: true, reason: null };
  } catch (error) {
    if (!(error instanceof ProductionAuthorizationError)) throw error;
    return { canonical: false, reason: error.message };
  }
}

export function validateReleasePackageVersions({
  configuredFixedPackageNames,
  manifests,
  expectedVersion,
}) {
  const expectedPackages = new Set(PUBLISHED_PACKAGES);
  const configuredPackages = new Set(configuredFixedPackageNames);
  const byName = new Map(
    manifests.map((entry) => [entry.manifest.name, entry])
  );
  const errors = [];

  for (const packageName of PUBLISHED_PACKAGES) {
    if (!configuredPackages.has(packageName)) {
      errors.push(`${packageName}: missing from the Changesets fixed group`);
    }

    const entry = byName.get(packageName);
    if (!entry) {
      errors.push(`${packageName}: package.json not found`);
    } else {
      if (entry.manifest.private === true) {
        errors.push(`${packageName}: package.json must not be private`);
      }
      if (entry.manifest.version !== expectedVersion) {
        errors.push(
          `${packageName}: ${
            entry.manifest.version ?? "missing version"
          } (expected ${expectedVersion})`
        );
      }
    }
  }

  for (const packageName of configuredPackages) {
    if (!expectedPackages.has(packageName)) {
      errors.push(
        `${packageName}: unexpected package in the Changesets fixed group`
      );
    }
  }

  for (const { manifestPath, manifest } of manifests) {
    if (manifest.private !== true && !expectedPackages.has(manifest.name)) {
      errors.push(
        `${
          manifest.name ?? manifestPath
        }: public workspace package missing from the release allowlist`
      );
    }
  }

  return errors;
}

export function validateNpmEvidence({ evidence, expectedVersion }) {
  requireCondition(
    Array.isArray(evidence),
    "Invalid npm publication evidence."
  );
  const byName = new Map();

  for (const item of evidence) {
    requireCondition(
      typeof item?.name === "string" && !byName.has(item.name),
      `npm evidence contains an invalid or duplicate package name '${item?.name}'.`
    );
    byName.set(item.name, item);
  }

  requireCondition(
    byName.size === PUBLISHED_PACKAGES.length,
    `Expected npm evidence for ${PUBLISHED_PACKAGES.length} packages; received ${byName.size}.`
  );

  for (const packageName of PUBLISHED_PACKAGES) {
    const item = byName.get(packageName);
    requireCondition(item, `Missing npm evidence for ${packageName}.`);
    requireCondition(
      item.versionExists === true,
      `${packageName}@${expectedVersion} is not present in the npm registry.`
    );
    requireCondition(
      item.latest === expectedVersion,
      `${packageName} has npm latest=${
        item.latest ?? "missing"
      }, expected ${expectedVersion}.`
    );
  }
}

function validateMainPolicyCheck({
  checkRuns,
  kind,
  firstParentSha,
  baseHasMainPolicy,
  candidateHasMainPolicy,
  mainPolicyWorkflowRun,
  mainPolicyPolicyIsAncestor,
  mainPolicyPolicyMatchesTrusted,
  mainPolicyPolicySha,
  pullRequest,
  repository,
  trustedPolicySha,
}) {
  const latest = latestMainPolicyCheck(checkRuns);
  const bootstrapAllowed =
    kind === "stable" &&
    firstParentSha === BOOTSTRAP_MAIN_SHA &&
    baseHasMainPolicy === false &&
    candidateHasMainPolicy === true;

  if (baseHasMainPolicy === false) {
    requireCondition(
      bootstrapAllowed,
      "A main base without policy is allowed only for the one-time stable bootstrap, whose candidate policy must exactly match the trusted canary policy."
    );
  }

  if (!latest) {
    throw new ProductionAuthorizationError(
      `The PR head has no '${MAIN_POLICY_CHECK}' check from GitHub Actions.`
    );
  }

  requireCondition(
    latest.app?.id === GITHUB_ACTIONS_APP_ID,
    `'${MAIN_POLICY_CHECK}' was reported by app ${
      latest.app?.id ?? "unknown"
    }, expected ${GITHUB_ACTIONS_APP_ID}.`
  );
  requireCondition(
    latest.status === "completed" && latest.conclusion === "success",
    `'${MAIN_POLICY_CHECK}' must be completed successfully; received ${latest.status}/${latest.conclusion}.`
  );
  requireCondition(
    latest.head_sha === pullRequest.head.sha,
    `'${MAIN_POLICY_CHECK}' was attached to ${
      latest.head_sha ?? "an unknown SHA"
    }, expected PR head ${pullRequest.head.sha}.`
  );
  const runId = mainPolicyRunIdFromDetailsUrl(latest.details_url, repository);
  requireCondition(
    runId !== null,
    `'${MAIN_POLICY_CHECK}' must link to an exact GitHub Actions run URL in ${repository}.`
  );
  requireCondition(
    String(mainPolicyWorkflowRun?.id) === runId,
    `'${MAIN_POLICY_CHECK}' links to run ${runId}, but GitHub returned ${
      mainPolicyWorkflowRun?.id ?? "no run"
    }.`
  );
  requireCondition(
    mainPolicyWorkflowRun.path === MAIN_POLICY_WORKFLOW_PATH,
    `'${MAIN_POLICY_CHECK}' must come from ${MAIN_POLICY_WORKFLOW_PATH}, not ${
      mainPolicyWorkflowRun.path ?? "an unknown workflow"
    }.`
  );
  requireCondition(
    mainPolicyWorkflowRun.event === "pull_request_target" &&
      mainPolicyWorkflowRun.status === "completed" &&
      mainPolicyWorkflowRun.conclusion === "success",
    "The linked main-policy workflow must be a completed, successful pull_request_target run."
  );
  requireCondition(
    mainPolicyWorkflowRun.head_branch === pullRequest.head.ref &&
      mainPolicyWorkflowRun.head_sha === pullRequest.head.sha,
    `The linked main-policy run targeted ${
      mainPolicyWorkflowRun.head_branch ?? "an unknown branch"
    } at ${mainPolicyWorkflowRun.head_sha ?? "an unknown SHA"}, expected ${
      pullRequest.head.ref
    } at ${pullRequest.head.sha}.`
  );
  requireCondition(
    mainPolicyWorkflowRun.head_repository?.full_name === repository,
    `The linked main-policy run must belong to ${repository}.`
  );
  requireCondition(
    mainPolicyWorkflowRun.display_title === mainPolicyRunName(pullRequest),
    "The linked main-policy run title does not match the exact PR base and head."
  );
  requireSha(mainPolicyPolicySha, "Main-policy revision SHA");
  requireCondition(
    latest.external_id ===
      mainPolicyCheckExternalId({
        workflowRun: mainPolicyWorkflowRun,
        pullRequest,
        policySha: mainPolicyPolicySha,
      }),
    `'${MAIN_POLICY_CHECK}' is not bound to the exact trusted workflow attempt, PR, base, and head.`
  );
  requireCondition(
    mainPolicyPolicyIsAncestor === true,
    `Main-policy revision ${mainPolicyPolicySha} is not an ancestor of current trusted policy ${trustedPolicySha}.`
  );
  requireCondition(
    mainPolicyPolicyMatchesTrusted === true,
    `Main-policy revision ${mainPolicyPolicySha} does not contain the same critical policy files as current trusted policy ${trustedPolicySha}. Rerun main-policy before merging.`
  );

  return { bootstrap: bootstrapAllowed };
}

function requireAuthorizedParent({
  authorizationWorkflowId,
  firstParentSha,
  parentAuthorizationRun,
  parentProductionStatus,
  repository,
}) {
  requireCondition(
    parentProductionStatus !== null,
    `First parent ${firstParentSha} has no '${PRODUCTION_AUTHORIZATION_CONTEXT}' status.`
  );
  requireCondition(
    parentProductionStatus.state === "success",
    `First parent ${firstParentSha} has '${PRODUCTION_AUTHORIZATION_CONTEXT}'=${parentProductionStatus.state}, expected success.`
  );

  if (firstParentSha === BOOTSTRAP_MAIN_SHA) return;

  validateCanonicalProductionAuthorizationStatus({
    status: parentProductionStatus,
    run: parentAuthorizationRun,
    repository,
    authorizedSha: firstParentSha,
    authorizationWorkflowId,
  });
}

function validateStableEvidence({
  candidateTreeSha,
  firstParentSha,
  githubRelease,
  npmEvidence,
  packageVersionErrors,
  parentIsTagAncestor,
  pullRequest,
  releaseJobs,
  releaseRun,
  repository,
  stableNpmAuditStatus,
  tagIsInCanary,
  tagSha,
  tagTreeSha,
  version,
}) {
  const tag = `v${version}`;
  requireCondition(
    packageVersionErrors.length === 0,
    `Stable package validation failed: ${packageVersionErrors.join(", ")}`
  );
  requireCondition(tagSha !== null, `Stable tag ${tag} does not exist.`);
  requireCondition(
    tagSha === pullRequest.head.sha,
    `${tag} resolves to ${tagSha}, but the promotion PR head is ${pullRequest.head.sha}.`
  );
  requireCondition(
    candidateTreeSha === tagTreeSha,
    `main tree ${candidateTreeSha} does not exactly match ${tag} tree ${tagTreeSha}.`
  );
  requireCondition(
    parentIsTagAncestor,
    `Previous main ${firstParentSha} is not an ancestor of ${tag}; canary must contain the complete production history.`
  );
  requireCondition(
    tagIsInCanary,
    `${tag} is not an ancestor of the current canary branch.`
  );
  requireCondition(
    githubRelease !== null,
    `GitHub Release ${tag} does not exist.`
  );
  requireCondition(
    githubRelease.tag_name === tag &&
      githubRelease.draft === false &&
      githubRelease.prerelease === false &&
      Boolean(githubRelease.published_at),
    `${tag} must be a published, non-draft, non-prerelease GitHub Release.`
  );
  requireCondition(
    stableNpmAuditStatus !== null,
    `${tagSha} has no '${STABLE_NPM_AUDIT_CONTEXT}' status.`
  );
  requireCondition(
    stableNpmAuditStatus.state === "success",
    `'${STABLE_NPM_AUDIT_CONTEXT}' is ${stableNpmAuditStatus.state}, expected success.`
  );

  const statusRunId = releaseRunIdFromStatusTarget(
    stableNpmAuditStatus.target_url,
    repository
  );
  requireCondition(
    statusRunId !== null,
    `'${STABLE_NPM_AUDIT_CONTEXT}' must link to a GitHub Actions run in ${repository}.`
  );
  requireCondition(
    String(releaseRun?.id) === statusRunId,
    `Stable npm status links to run ${statusRunId}, but GitHub returned ${
      releaseRun?.id ?? "no run"
    }.`
  );
  requireCondition(
    releaseRun.workflow_id === RELEASE_WORKFLOW_ID &&
      releaseRun.path === RELEASE_WORKFLOW_PATH,
    `Stable publication must come from Release workflow ${RELEASE_WORKFLOW_ID} at ${RELEASE_WORKFLOW_PATH}.`
  );
  requireCondition(
    releaseRun.event === "release" &&
      releaseRun.status === "completed" &&
      releaseRun.conclusion === "success",
    "The linked Release workflow run must be a completed, successful release event."
  );
  requireCondition(
    releaseRun.head_sha === tagSha && releaseRun.head_branch === tag,
    `The linked Release run must target ${tag} at ${tagSha}.`
  );
  requireCondition(
    Array.isArray(releaseJobs) &&
      releaseJobs.some(
        (job) =>
          job.name === "publish" &&
          job.status === "completed" &&
          job.conclusion === "success"
      ),
    "The linked Release run has no successful publish job."
  );

  validateNpmEvidence({ evidence: npmEvidence, expectedVersion: version });

  return { tag, version };
}

export function evaluateProductionAuthorization({
  authorizationWorkflowId,
  baseHasMainPolicy,
  candidateHasMainPolicy,
  candidateSha,
  candidateTreeSha,
  changedPaths,
  checkRuns,
  mainPolicyWorkflowRun,
  mainPolicyPolicyIsAncestor,
  mainPolicyPolicyMatchesTrusted,
  mainPolicyPolicySha,
  npmEvidence,
  packageVersionErrors,
  parentIsTagAncestor,
  parentAuthorizationRun,
  parentProductionStatus,
  parents,
  pullRequests,
  release,
  releaseJobs,
  releaseRun,
  repository,
  stableNpmAuditStatus,
  tagIsInCanary,
  tagSha,
  tagTreeSha,
  trustedPolicySha,
}) {
  requireSha(candidateSha, "Candidate SHA");
  requireSha(trustedPolicySha, "Trusted policy SHA");
  requireCondition(Array.isArray(parents), "Invalid candidate parent data.");
  const firstParentSha = parents[0];
  requireSha(firstParentSha, "First parent SHA");
  requireAuthorizedParent({
    authorizationWorkflowId,
    firstParentSha,
    parentAuthorizationRun,
    parentProductionStatus,
    repository,
  });

  const pullRequest = selectAssociatedPullRequest({
    candidateSha,
    pullRequests,
    repository,
    firstParentSha,
    parents,
  });
  const headRef = pullRequest.head.ref;
  const promotionVersion = promotionVersionFromBranch(headRef);
  const kind = SITE_BRANCH.test(headRef)
    ? "site"
    : promotionVersion !== null
    ? "stable"
    : null;

  requireCondition(
    kind !== null,
    `PR #${pullRequest.number} must use site/<name> or promote/vX.Y.Z; received '${headRef}'.`
  );

  const mainPolicy = validateMainPolicyCheck({
    checkRuns,
    kind,
    firstParentSha,
    baseHasMainPolicy,
    candidateHasMainPolicy,
    mainPolicyWorkflowRun,
    mainPolicyPolicyIsAncestor,
    mainPolicyPolicyMatchesTrusted,
    mainPolicyPolicySha,
    pullRequest,
    repository,
    trustedPolicySha,
  });

  if (kind === "site") {
    requireCondition(
      Array.isArray(changedPaths),
      "Invalid first-parent diff data."
    );
    requireCondition(
      changedPaths.length > 0,
      "A web-only main commit must change at least one file."
    );
    const disallowedPaths = changedPaths.filter(
      (path) => !path.startsWith("apps/docs/")
    );
    requireCondition(
      disallowedPaths.length === 0,
      `A site/* commit may change only apps/docs/**. Disallowed paths: ${disallowedPaths.join(
        ", "
      )}`
    );

    return {
      kind,
      pullRequestNumber: pullRequest.number,
      bootstrap: false,
      message: `Authorized web-only PR #${pullRequest.number}: ${changedPaths.length} file(s) under apps/docs/**.`,
    };
  }

  requireCondition(
    parents.length === 2,
    `A stable promotion must use a two-parent merge commit; received ${parents.length} parent(s).`
  );

  const stable = validateStableEvidence({
    candidateTreeSha,
    firstParentSha,
    githubRelease: release,
    npmEvidence,
    packageVersionErrors,
    parentIsTagAncestor,
    pullRequest,
    releaseJobs,
    releaseRun,
    repository,
    stableNpmAuditStatus,
    tagIsInCanary,
    tagSha,
    tagTreeSha,
    version: promotionVersion,
  });

  return {
    kind,
    pullRequestNumber: pullRequest.number,
    bootstrap: mainPolicy.bootstrap,
    ...stable,
    message: `Authorized stable promotion ${stable.tag} from PR #${pullRequest.number}; main exactly matches the published tag.`,
  };
}
