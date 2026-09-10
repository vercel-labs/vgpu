import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { checkPrRelease } from "./lib/pr-release.mjs";
import { validateSharedHeadPrs } from "./lib/shared-head-prs.mjs";

const head = "a".repeat(40);
const base = "b".repeat(40);
const body = "## PR type\n\ndevelopment\n\n## Release impact\n\nnone — Changes already accounted for in their original PRs.";
const pr = (number: number, branch = "canary", description = body) => ({ number, state: "open", body: description, head: { sha: head }, base: { sha: base, ref: branch } });
type Pr = ReturnType<typeof pr>;
function apiFor(event: Pr, inventories: Pr[][], eventVersions: Pr[] = []) {
  let scan = 0;
  let read = 0;
  return vi.fn(async (path: string) => {
    if (path === `pulls/${event.number}`) return eventVersions[read++] ?? event;
    const page = Number(new URL(`https://api.github.com/${path}`).searchParams.get("page"));
    if (page === 1) scan++;
    const inventory = inventories[Math.min(scan - 1, inventories.length - 1)];
    return inventory.slice((page - 1) * 100, page * 100);
  });
}

describe("commit-scoped release impact", () => {
  it("cannot bless a canary version bump by validating a main PR with the same SHA", async () => {
    const event = pr(1, "main");
    const other = pr(2);
    const path = "packages/vgpu-api/package.json";
    const reader = (version: string) => ({ paths: [path], read: () => JSON.stringify({ name: "vgpu", private: false, version }) });
    const evaluate = (candidate: Pr) => checkPrRelease({
      body: candidate.body, baseBranch: candidate.base.ref, changedFiles: [{ status: "M", path }],
      base: reader("0.5.0-rc.0"), head: reader("0.5.0-rc.1"),
    });
    expect(evaluate(event).type).toBe("development");
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[event, other]]), eventPr: event, evaluate })).rejects.toThrow("PR #2 targeting canary: Public package versions changed");
  });

  it("validates differing descriptions on same-base duplicate heads", async () => {
    const event = pr(1);
    const other = pr(2, "canary", "Missing all declarations.");
    const evaluate = (candidate: Pr) => checkPrRelease({
      body: candidate.body, baseBranch: candidate.base.ref, changedFiles: [],
      base: { paths: [], read: () => undefined }, head: { paths: [], read: () => undefined },
    });
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[event, other]]), eventPr: event, evaluate })).rejects.toThrow("PR #2 targeting canary: PR description requires exactly one ## PR type");
  });

  it("reads every page and excludes other heads, closed PRs and unsupported targets", async () => {
    const event = pr(1);
    const unrelated = Array.from({ length: 100 }, (_, index) => ({ ...pr(index + 10), head: { sha: "c".repeat(40) } }));
    const other = pr(2, "main");
    const api = apiFor(event, [[event, ...unrelated, other, pr(3, "other"), { ...pr(4), state: "closed" }]]);
    const evaluate = vi.fn(() => ({ type: "development" }));
    await expect(validateSharedHeadPrs({ api, eventPr: event, evaluate })).resolves.toEqual([{ number: 1, type: "development" }, { number: 2, type: "development" }]);
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(api.mock.calls.filter(([path]) => path.includes("page=2"))).toHaveLength(2);
  });

  it("fails closed if the authoritative event PR is missing from the inventory", async () => {
    const event = pr(1);
    const evaluate = vi.fn();
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[]]), eventPr: event, evaluate })).rejects.toThrow("missing or stale");
    expect(evaluate).not.toHaveBeenCalled();
  });

  it("fails closed if the inventory has a stale event description", async () => {
    const event = pr(1);
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[{ ...event, body: "old" }]]), eventPr: event, evaluate: vi.fn() })).rejects.toThrow("missing or stale");
  });

  it.each(["addition", "removal", "body", "base", "head"])("rejects a concurrent shared-PR %s", async change => {
    const event = pr(1);
    const other = pr(2);
    const after = change === "addition" ? [event, other, pr(3)] : change === "removal" ? [event] : [event, {
      ...other,
      ...(change === "body" ? { body: "Changed declaration" } : change === "base" ? { base: { ...other.base, sha: "d".repeat(40) } } : { head: { sha: "e".repeat(40) } }),
    }];
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[event, other], after]), eventPr: event, evaluate: () => ({ type: "development" }) })).rejects.toThrow("inventory or descriptions changed");
  });

  it("rejects event movement even when the open-list snapshot is unchanged", async () => {
    const event = pr(1);
    const moved = { ...event, base: { ...event.base, sha: "d".repeat(40) } };
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[event]], [event, moved]), eventPr: event, evaluate: () => ({ type: "development" }) })).rejects.toThrow("Event PR moved");
  });

  it("refreshes the remaining PRs after an invalid duplicate closes", async () => {
    const event = { ...pr(1, "canary", "invalid"), state: "closed" };
    const other = pr(2);
    const evaluate = vi.fn(() => ({ type: "development" }));
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[other]]), eventPr: event, evaluate })).resolves.toEqual([{ number: 2, type: "development" }]);
    expect(evaluate).toHaveBeenCalledWith(other);
    await expect(validateSharedHeadPrs({ api: apiFor(event, [[]]), eventPr: event, evaluate })).resolves.toEqual([]);
  });

  it("uses SHA concurrency and a close-event refresh without executing candidate code", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-impact.yml", import.meta.url), "utf8");
    expect(workflow).toContain("closed, edited]");
    expect(workflow).toContain("group: release-impact-${{ github.event.pull_request.head.sha }}");
    expect(workflow).toContain("ref: ${{ github.workflow_sha }}");
    expect(workflow).toContain("ref: ${{ github.event.pull_request.head.sha }}");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    expect(workflow).not.toContain("pnpm install");
  });

  it("declares the required check as the unconditional Actions job", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-impact.yml", import.meta.url), "utf8");
    expect(workflow.match(/^    name: release-impact$/gm)).toHaveLength(1);
    expect(workflow).not.toMatch(/^\s+(?:if|continue-on-error):/m);
    expect(workflow).toContain("timeout-minutes: 5");
    expect(workflow).toMatch(/^        run: node \.release-impact\/trusted\/scripts\/check-release-impact\.mjs \.release-impact\/candidate$/m);
  });

  it("leaves check reporting to Actions with read-only token permissions", () => {
    const workflow = readFileSync(new URL("../.github/workflows/release-impact.yml", import.meta.url), "utf8");
    expect(workflow).toContain("  contents: read");
    expect(workflow).toContain("  pull-requests: read");
    expect(workflow).not.toMatch(/:\s*write(?:-all)?\s*(?:#.*)?$/m);
    expect(workflow).not.toContain("check-runs");
    expect(workflow).not.toContain("gh api");
  });
});
