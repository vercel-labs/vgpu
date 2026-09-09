export const STABLE_NPM_AUDIT_CONTEXT = "vgpu: stable npm published";
export const PRODUCTION_AUTHORIZATION_CONTEXT =
  "Vercel - vgpu: production authorized";
export const BOOTSTRAP_MAIN_SHA = "e1661e3385ac63dc88535c1a0e819e52702f02f8";

const STABLE_VERSION =
  "(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)";
const PROMOTION_BRANCH = new RegExp(`^promote/v(${STABLE_VERSION})$`);
const SITE_BRANCH = /^site\/.+/;

export class MainPrPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = "MainPrPolicyError";
  }
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new MainPrPolicyError(message);
  }
}

export function promotionVersionFromBranch(headRef) {
  return PROMOTION_BRANCH.exec(headRef)?.[1] ?? null;
}

export function evaluateMainPrPolicy({
  repository,
  headRepository,
  baseRef,
  baseSha,
  currentBaseSha,
  baseProductionStatus,
  baseIsAncestor,
  headRef,
  headSha,
  currentHeadSha,
  changedPaths,
  tagSha,
  stableNpmAuditStatus,
  releaseVersionErrors = [],
}) {
  requireCondition(
    baseRef === "main",
    `Expected base branch 'main', received '${baseRef}'.`
  );
  requireCondition(
    headRepository === repository,
    "PRs into main must use a branch in this repository, not a fork."
  );
  requireCondition(
    currentBaseSha === baseSha,
    `The main branch moved while main-policy was running (event ${baseSha}, current ${currentBaseSha}). Rerun the check against the latest main.`
  );
  requireCondition(
    currentHeadSha === headSha,
    `The branch moved while main-policy was running (event ${headSha}, current ${currentHeadSha}). Rerun the check on the latest head.`
  );
  requireCondition(
    baseIsAncestor,
    "The PR head must contain the current main base commit. Update the branch from main and rerun CI."
  );
  requireCondition(
    baseProductionStatus !== null,
    `Current main ${currentBaseSha} has no '${PRODUCTION_AUTHORIZATION_CONTEXT}' status. Wait for its production authorization before merging another PR.`
  );
  requireCondition(
    baseProductionStatus.state === "success",
    `'${PRODUCTION_AUTHORIZATION_CONTEXT}' on current main ${currentBaseSha} is '${baseProductionStatus.state}', not 'success'. Wait for production authorization and rerun main-policy.`
  );
  requireCondition(
    changedPaths.length > 0,
    "The PR must contain at least one changed file."
  );

  if (baseSha === BOOTSTRAP_MAIN_SHA) {
    requireCondition(
      promotionVersionFromBranch(headRef) !== null,
      "The one-time main bootstrap accepts only a promote/vX.Y.Z stable promotion."
    );
  }

  if (SITE_BRANCH.test(headRef)) {
    const disallowedPaths = changedPaths.filter(
      (path) => !path.startsWith("apps/docs/")
    );
    requireCondition(
      disallowedPaths.length === 0,
      `A site/* PR may change only apps/docs/**. Disallowed paths: ${disallowedPaths.join(
        ", "
      )}`
    );

    return {
      kind: "site",
      message: `Authorized web-only PR: ${changedPaths.length} changed file(s), all under apps/docs/**.`,
    };
  }

  const version = promotionVersionFromBranch(headRef);
  if (version !== null) {
    const tag = `v${version}`;

    requireCondition(
      releaseVersionErrors.length === 0,
      `Promotion package validation failed: ${releaseVersionErrors.join(", ")}`
    );
    requireCondition(
      tagSha !== null,
      `Stable tag ${tag} does not exist yet. Publish npm successfully, then mark the draft PR ready or rerun main-policy.`
    );
    requireCondition(
      tagSha === headSha,
      `${tag} resolves to ${tagSha}, but the promotion branch resolves to ${headSha}. The tag and PR head must be the same commit.`
    );
    requireCondition(
      stableNpmAuditStatus !== null,
      `Commit ${headSha} has no '${STABLE_NPM_AUDIT_CONTEXT}' status. Wait for the stable npm publication workflow.`
    );
    requireCondition(
      stableNpmAuditStatus.state === "success",
      `'${STABLE_NPM_AUDIT_CONTEXT}' is '${stableNpmAuditStatus.state}', not 'success'.`
    );

    return {
      kind: "promotion",
      version,
      tag,
      message: `Authorized stable promotion ${tag}: tag, package versions, branch head, and npm audit status match ${headSha}.`,
    };
  }

  throw new MainPrPolicyError(
    "PRs into main must use either site/<name> for an apps/docs-only update or promote/vX.Y.Z for a published stable promotion."
  );
}

export function validateReleasePackageVersions({
  fixedPackageNames,
  manifests,
  expectedVersion,
}) {
  const fixedPackages = new Set(fixedPackageNames);
  const byName = new Map(
    manifests.map((entry) => [entry.manifest.name, entry])
  );
  const errors = [];

  for (const packageName of fixedPackages) {
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

  for (const { manifestPath, manifest } of manifests) {
    if (manifest.private !== true && !fixedPackages.has(manifest.name)) {
      errors.push(
        `${
          manifest.name ?? manifestPath
        }: public workspace package missing from the fixed group`
      );
    }
  }

  return errors;
}
