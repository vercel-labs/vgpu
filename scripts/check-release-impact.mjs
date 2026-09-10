#!/usr/bin/env node
// Executed only from the trusted workflow checkout. Candidate files are read as Git blobs,
// never imported/executed or read via filesystem paths (including candidate symlinks).
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { checkImpact } from "./lib/migrations.mjs";

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
const pr = await api(`pulls/${number}`);
if (pr.head.sha !== event.pull_request.head.sha || pr.base.sha !== event.pull_request.base.sha) throw new Error("PR moved; use the workflow run for its current head/base.");
let summary;
try {
  const git = (...args) => execFileSync("git", ["-C", candidate, ...args], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const diff = git("diff", "--no-renames", "--name-status", "-z", `${pr.base.sha}...${pr.head.sha}`).split("\0").filter(Boolean);
  const files = [];
  for (let index = 0; index < diff.length; index += 2) files.push({ status: diff[index], path: diff[index + 1] });
  const impact = checkImpact(pr.body ?? "", files, path => git("show", `${pr.head.sha}:${path}`));
  const latest = await api(`pulls/${number}`);
  if (latest.head.sha !== pr.head.sha || latest.base.sha !== pr.base.sha || latest.body !== pr.body) throw new Error("PR changed during validation; rerun for the current description and commits.");
  summary = impact.kind === "none" ? `No release impact declared: ${impact.reason}. Review this justification against the diff; this check does not infer behavioral compatibility.` : `Validated ${impact.paths.length} new changeset(s), including explicit migration decisions.`;
} catch (error) {
  summary = error.message;
  process.exitCode = 1;
} finally {
  console.log(summary);
}
