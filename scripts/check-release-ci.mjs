#!/usr/bin/env node

import {
  CI_WORKFLOW_ID,
  ProductionAuthorizationError,
  selectCiPushRunForRelease,
  validateCiWorkflowJobs,
} from "./lib/production-authorization.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new ProductionAuthorizationError(
      `Missing required environment variable ${name}.`
    );
  }
  return value;
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

async function githubJson(url, token, description) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "vgpu-release-ci-gate",
        "X-GitHub-Api-Version": "2026-03-10",
      },
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

async function paginatedCollection({
  apiUrl,
  path,
  property,
  token,
  description,
}) {
  const items = [];
  for (let page = 1; ; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const payload = await githubJson(
      `${apiUrl}${path}${separator}per_page=100&page=${page}`,
      token,
      `${description} (page ${page})`
    );
    const pageItems = payload?.[property];
    if (!Array.isArray(pageItems)) {
      throw new ProductionAuthorizationError(
        `${description} returned an invalid '${property}' collection.`
      );
    }
    items.push(...pageItems);
    if (pageItems.length < 100) return items;
  }
}

async function main() {
  const token = requiredEnvironment("GITHUB_TOKEN");
  const repository = requiredEnvironment("GITHUB_REPOSITORY");
  const releaseBranch = requiredEnvironment("RELEASE_BRANCH");
  const releaseSha = requiredEnvironment("GITHUB_SHA");
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const repoPath = repositoryApiPath(repository);
  const query = new URLSearchParams({
    branch: releaseBranch,
    event: "push",
    head_sha: releaseSha,
  });
  const runs = await paginatedCollection({
    apiUrl,
    path: `/repos/${repoPath}/actions/workflows/${CI_WORKFLOW_ID}/runs?${query}`,
    property: "workflow_runs",
    token,
    description: `Reading CI push runs for ${releaseSha}`,
  });
  const run = selectCiPushRunForRelease({
    runs,
    repository,
    releaseBranch,
    releaseSha,
  });
  const jobs = await paginatedCollection({
    apiUrl,
    path: `/repos/${repoPath}/actions/runs/${encodeURIComponent(
      run.id
    )}/jobs?filter=latest`,
    property: "jobs",
    token,
    description: `Reading jobs for CI run ${run.id}`,
  });
  validateCiWorkflowJobs(jobs);
  console.log(
    `Release gate accepted CI run ${run.id}: every required job succeeded for ${releaseBranch} at ${releaseSha}.`
  );
}

main().catch((error) => {
  const message = (error instanceof Error ? error.message : String(error))
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.error(`::error::${message}`);
  process.exitCode = 1;
});
