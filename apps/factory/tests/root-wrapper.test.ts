import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

describe("root factory wrapper", () => {
  it("forwards the triage subcommand to the inner runner", () => {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/factory.mjs",
        "triage",
        "--fixture",
        "does-not-exist.json",
        "--dry-run",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          AI_GATEWAY_API_KEY: "test-only-key",
          GITHUB_TOKEN: "",
        },
      }
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unable to resolve fixture path");
    expect(result.stderr).not.toContain('Expected the "triage" command');
  });
});
