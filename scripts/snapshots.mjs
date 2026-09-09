import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const capture = (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

/** Dispatches only committed, pushed code. Never commits, pushes or applies PNGs. */
export async function runSnapshots(mode, dependencies = {}) {
  const read = dependencies.capture ?? capture;
  const execute = dependencies.run ?? run;
  const sleep = dependencies.sleep ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  const request = dependencies.request ?? randomUUID();
  if (!["check", "update"].includes(mode)) throw new Error("Usage: pnpm snapshots:check | pnpm snapshots:update");
  if (read("git", ["status", "--porcelain"])) {
    throw new Error("CI cannot see uncommitted changes. Commit and push the intended revision first; this command never does that for you.");
  }
  const branch = read("git", ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const sha = read("git", ["rev-parse", "HEAD"]);
  const remote = read("git", ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`]).split(/\s/)[0];
  if (remote !== sha) throw new Error("origin does not contain this branch's HEAD. Push the intended revision before running snapshots.");
  const repo = read("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  const title = `Snapshots ${mode} / ${request}`;
  console.log(`Requesting native x64 snapshots for ${repo}@${sha}. No references will be overwritten.`);
  try {
    read("gh", ["workflow", "run", "snapshots.yml", "--repo", repo, "--ref", branch,
      "--field", `mode=${mode}`, "--field", `request=${request}`]);
  } catch (error) {
    throw new Error(`Could not dispatch snapshots. Check GitHub permissions and that snapshots.yml exists on the default branch. During bootstrap, use the automatic PR check's visual-snapshots artifact.\n${error.message}`);
  }
  let workflow;
  for (let attempt = 0; attempt < 20 && !workflow; attempt++) {
    if (attempt) await sleep(3000);
    const runs = JSON.parse(read("gh", ["run", "list", "--repo", repo, "--workflow", "snapshots.yml", "--event", "workflow_dispatch",
      "--branch", branch, "--limit", "50", "--json", "databaseId,displayTitle,headSha,url"]));
    workflow = runs.find((candidate) => candidate.displayTitle === title && candidate.headSha === sha);
  }
  if (!workflow) throw new Error(`Workflow dispatched but not found yet. Open https://github.com/${repo}/actions/workflows/snapshots.yml and find ${title}.`);
  console.log(workflow.url);
  const status = execute("gh", ["run", "watch", String(workflow.databaseId), "--repo", repo, "--exit-status"]);
  const directory = resolve("artifacts", `snapshots-${workflow.databaseId}`);
  const downloaded = execute("gh", ["run", "download", String(workflow.databaseId), "--repo", repo,
    "--name", "visual-snapshots", "--dir", directory]);
  if (!downloaded) {
    console.log(`Review: ${directory}/index.html`);
    if (mode === "update") console.log(`Unapproved candidates: ${directory}/candidates. Review the diffs before copying selected PNGs into the checkout; then commit and rerun snapshots:check.`);
  } else console.error(`Could not download reports. Inspect ${workflow.url}; the renderer may have failed before producing artifacts.`);
  return status || downloaded;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await runSnapshots(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
