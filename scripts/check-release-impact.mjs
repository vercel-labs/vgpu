#!/usr/bin/env node
// Executed only from the trusted workflow checkout. Candidate files are read as Git blobs,
// never imported/executed or read via filesystem paths (including candidate symlinks).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { checkPrRelease, gitDataReader } from "./lib/pr-release.mjs";
import { validateSharedHeadPrs } from "./lib/shared-head-prs.mjs";

const candidate = resolve(process.argv[2] ?? ".");
const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
const number = event.pull_request?.number;
if (!/^[\w.-]+\/[\w.-]+$/u.test(repository ?? "") || !token || !Number.isSafeInteger(number)) throw new Error("Missing trusted GitHub PR context.");
async function api(path) {
  const response = await fetch(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }, signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`GitHub API GET ${path}: HTTP ${response.status}`);
  return response.json();
}
let summary;
try {
  const git = (...args) => execFileSync("git", ["-C", candidate, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const results = await validateSharedHeadPrs({ api, eventPr: event.pull_request, evaluate(pr) {
    const diff = git("diff", "--no-renames", "--name-status", "-z", `${pr.base.sha}...${pr.head.sha}`).split("\0").filter(Boolean);
    const files = [];
    for (let index = 0; index < diff.length; index += 2) files.push({ status: diff[index], path: diff[index + 1] });
    return checkPrRelease({
      body: pr.body ?? "", baseBranch: pr.base.ref, changedFiles: files,
      base: gitDataReader(git, git("merge-base", pr.base.sha, pr.head.sha).trim()),
      target: gitDataReader(git, pr.base.sha), head: gitDataReader(git, pr.head.sha),
    });
  },
  });
  summary = `Validated ${results.length} open PR(s) sharing this commit: ${results.map(result => `#${result.number} (${result.type}${result.version ? ` ${result.version}` : ""})`).join(", ") || "none remain"}. Review compatibility claims against the diffs; CI does not infer behavioral compatibility.`;
} catch (error) {
  summary = error.message;
  process.exitCode = 1;
} finally {
  console.log(summary);
}
