import { expect, test, vi } from "vitest";
import { runSnapshots } from "./snapshots.mjs";

function harness(overrides: Record<string, string> = {}, status = 0) {
  const capture = vi.fn((command: string, args: string[]) => {
    const key = `${command} ${args.slice(0, 2).join(" ")}`;
    if (key in overrides) return overrides[key];
    if (key === "git status --porcelain") return "";
    if (key === "git symbolic-ref --quiet") return "feature";
    if (key === "git rev-parse HEAD") return "abc";
    if (key === "git ls-remote --exit-code") return "abc\trefs/heads/feature";
    if (key === "gh repo view") return "owner/repo";
    if (key === "gh workflow run") return "";
    if (key === "gh run list") return JSON.stringify([{ databaseId: 42, displayTitle: "Snapshots check / test-id", headSha: "abc", url: "https://github.com/owner/repo/actions/runs/42" }]);
    throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
  });
  const run = vi.fn((_command: string, args: string[]) => args[1] === "watch" ? status : 0);
  return { capture, run, sleep: vi.fn(async () => {}), request: "test-id" };
}

test("dirty or unpushed work is rejected without dispatching or mutating git", async () => {
  for (const override of [{ "git status --porcelain": " M file" }, { "git ls-remote --exit-code": "old\trefs/heads/feature" }]) {
    const h = harness(override);
    await expect(runSnapshots("check", h)).rejects.toThrow(/Commit|Push/);
    expect(h.capture.mock.calls.some(([command, args]) => command === "gh" && args[0] === "workflow")).toBe(false);
    expect(h.run).not.toHaveBeenCalled();
  }
});

test("checks are correlated to the exact SHA and download reports even after test failure", async () => {
  const h = harness({}, 1);
  expect(await runSnapshots("check", h)).toBe(1);
  expect(h.capture).toHaveBeenCalledWith("gh", expect.arrayContaining(["workflow", "run", "mode=check", "--ref", "feature"]));
  expect(h.run).toHaveBeenCalledWith("gh", expect.arrayContaining(["watch", "42"]));
  expect(h.run).toHaveBeenCalledWith("gh", expect.arrayContaining(["download", "42", "visual-snapshots"]));
});

test("a different revision or another user's run is never watched or downloaded", async () => {
  const h = harness({ "gh run list": JSON.stringify([{ databaseId: 42, displayTitle: "Snapshots check / test-id", headSha: "other" }]) });
  await expect(runSnapshots("check", h)).rejects.toThrow("Workflow dispatched but not found");
  expect(h.run).not.toHaveBeenCalled();
});

test("update dispatches candidate generation without applying changes", async () => {
  const h = harness({ "gh run list": JSON.stringify([{ databaseId: 42, displayTitle: "Snapshots update / test-id", headSha: "abc", url: "https://example.test/run" }]) });
  expect(await runSnapshots("update", h)).toBe(0);
  expect(h.capture).toHaveBeenCalledWith("gh", expect.arrayContaining(["mode=update"]));
  expect(h.run.mock.calls).toHaveLength(2);
});

test("invalid modes fail before any command", async () => {
  const h = harness();
  await expect(runSnapshots("typo", h)).rejects.toThrow("Usage:");
  expect(h.capture).not.toHaveBeenCalled();
});
