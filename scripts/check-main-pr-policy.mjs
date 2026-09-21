#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  MainPrPolicyError,
  PRODUCTION_AUTHORIZATION_CONTEXT,
  STABLE_NPM_AUDIT_CONTEXT,
  evaluateMainPrPolicy,
  promotionVersionFromBranch,
  validateReleasePackageVersions,
} from "./lib/main-pr-policy.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new MainPrPolicyError(
      `Missing required environment variable ${name}.`
    );
  }
  return value;
}

function git(repositoryRoot, args, options = {}) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: options.encoding ?? "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function gitSucceeds(repositoryRoot, args) {
  const result = spawnSync("git", ["-C", repositoryRoot, ...args], {
    stdio: "ignore",
  });
  return result.status === 0;
}

function changedPaths(repositoryRoot, baseSha, headSha) {
  const output = git(
    repositoryRoot,
    [
      "diff",
      "--no-ext-diff",
      "--name-only",
      "--no-renames",
      "-z",
      baseSha,
      headSha,
    ],
    { encoding: "buffer" }
  );
  return output.toString("utf8").split("\0").filter(Boolean);
}

function readJson(path, description) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new MainPrPolicyError(
      `Could not read ${description}: ${error.message}`
    );
  }
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

function releaseVersionErrors(repositoryRoot, expectedVersion) {
  const changesetConfig = readJson(
    resolve(repositoryRoot, ".changeset/config.json"),
    ".changeset/config.json"
  );
  if (!Array.isArray(changesetConfig.fixed)) {
    throw new MainPrPolicyError(
      ".changeset/config.json must define fixed package groups."
    );
  }

  return validateReleasePackageVersions({
    fixedPackageNames: changesetConfig.fixed.flat(),
    manifests: collectWorkspaceManifests(repositoryRoot),
    expectedVersion,
  });
}

function repositoryApiPath(repository) {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new MainPrPolicyError(
      `Invalid GITHUB_REPOSITORY value '${repository}'.`
    );
  }
  return parts.map(encodeURIComponent).join("/");
}

async function githubJson(path) {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetch(`${apiUrl}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2026-03-10",
      "User-Agent": "vgpu-main-pr-policy",
    },
  });

  if (!response.ok) {
    throw new MainPrPolicyError(
      `GitHub API request ${path} failed (${
        response.status
      }): ${await response.text()}`
    );
  }

  return response.json();
}

async function currentBranchSha(repository, branch) {
  const encodedRef = branch.split("/").map(encodeURIComponent).join("/");
  const result = await githubJson(
    `/repos/${repositoryApiPath(repository)}/git/ref/heads/${encodedRef}`
  );
  return result.object?.sha ?? null;
}

async function latestCommitStatus(repository, sha, context) {
  const statuses = await githubJson(
    `/repos/${repositoryApiPath(repository)}/commits/${encodeURIComponent(
      sha
    )}/statuses?per_page=100`
  );
  if (!Array.isArray(statuses)) {
    throw new MainPrPolicyError(
      "GitHub returned an invalid commit-status response."
    );
  }

  // The endpoint normally returns newest-first, but sort explicitly so a later failure or
  // correction can never be masked by an older success with the same context.
  const status = statuses
    .filter((candidate) => candidate.context === context)
    .sort((left, right) => {
      const timestampOrder = String(
        right.updated_at ?? right.created_at ?? ""
      ).localeCompare(String(left.updated_at ?? left.created_at ?? ""));
      if (timestampOrder !== 0) return timestampOrder;
      return Number(right.id ?? 0) - Number(left.id ?? 0);
    })[0];
  return status
    ? {
        state: status.state,
        targetUrl: status.target_url,
        creator: status.creator?.login,
      }
    : null;
}

async function main() {
  const repositoryRoot = resolve(process.argv[2] ?? ".");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const headRepository = requiredEnvironment("PR_HEAD_REPOSITORY");
  const baseRef = requiredEnvironment("PR_BASE_REF");
  const baseSha = requiredEnvironment("PR_BASE_SHA");
  const headRef = requiredEnvironment("PR_HEAD_REF");
  const headSha = requiredEnvironment("PR_HEAD_SHA");

  const checkedOutSha = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
  if (checkedOutSha !== headSha) {
    throw new MainPrPolicyError(
      `Candidate checkout is ${checkedOutSha}, but the PR event head is ${headSha}.`
    );
  }

  const [currentBaseSha, currentHeadSha] = await Promise.all([
    currentBranchSha(repository, baseRef),
    currentBranchSha(repository, headRef),
  ]);
  const baseIsAncestor = gitSucceeds(repositoryRoot, [
    "merge-base",
    "--is-ancestor",
    currentBaseSha,
    headSha,
  ]);
  const paths = changedPaths(repositoryRoot, currentBaseSha, headSha);
  const version = promotionVersionFromBranch(headRef);
  const tag = version === null ? null : `v${version}`;
  const tagRef = tag === null ? null : `refs/tags/${tag}`;
  const tagSha =
    tagRef !== null &&
    gitSucceeds(repositoryRoot, ["show-ref", "--verify", "--quiet", tagRef])
      ? git(repositoryRoot, ["rev-parse", `${tagRef}^{commit}`]).trim()
      : null;
  const [baseProductionStatus, auditStatus] = await Promise.all([
    latestCommitStatus(
      repository,
      currentBaseSha,
      PRODUCTION_AUTHORIZATION_CONTEXT
    ),
    version === null
      ? Promise.resolve(null)
      : latestCommitStatus(repository, headSha, STABLE_NPM_AUDIT_CONTEXT),
  ]);
  const versionErrors =
    version === null ? [] : releaseVersionErrors(repositoryRoot, version);

  const result = evaluateMainPrPolicy({
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
    changedPaths: paths,
    tagSha,
    stableNpmAuditStatus: auditStatus,
    releaseVersionErrors: versionErrors,
  });

  console.log(result.message);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.env.GITHUB_ACTIONS === "true") {
    const escapedMessage = message
      .replaceAll("%", "%25")
      .replaceAll("\r", "%0D")
      .replaceAll("\n", "%0A");
    console.error(`::error::${escapedMessage}`);
  } else {
    console.error(`main-policy: ${message}`);
  }
  process.exitCode = 1;
});
