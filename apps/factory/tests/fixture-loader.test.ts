import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadTriageFixture,
  validateNormalizedContext,
} from "../src/fixture-loader.ts";
import { FactoryUsageError } from "../src/errors.ts";
import { makeContext } from "./test-helpers.ts";

const temporaryDirectories: string[] = [];
const repositoryRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../.."
);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("loadTriageFixture", () => {
  it("loads normalized fixtures from a repository-relative path", async () => {
    const fixture = await loadTriageFixture(
      "apps/factory/evals/fixtures/bug.json",
      { repositoryRoot }
    );
    expect(fixture.repository.name).toBe("vgpu");
    expect(fixture.issue.sourceId).toBe(`issue:${fixture.issue.number}`);
  });

  it.each(["/tmp/fixture.json", "", "fixture.txt"])(
    'rejects invalid fixture path "%s"',
    async (fixturePath) => {
      await expect(
        loadTriageFixture(fixturePath, { repositoryRoot })
      ).rejects.toBeInstanceOf(FactoryUsageError);
    }
  );

  it("rejects lexical traversal and symlink escapes", async () => {
    const parent = await mkdtemp(resolve(tmpdir(), "vgpu-factory-fixture-"));
    temporaryDirectories.push(parent);
    const fakeRepository = resolve(parent, "repo");
    await mkdir(fakeRepository);
    const outside = resolve(parent, "outside.json");
    await writeFile(outside, JSON.stringify(makeContext()), "utf8");
    await symlink(outside, resolve(fakeRepository, "linked.json"));

    await expect(
      loadTriageFixture("../outside.json", { repositoryRoot: fakeRepository })
    ).rejects.toThrow("outside");
    await expect(
      loadTriageFixture("linked.json", { repositoryRoot: fakeRepository })
    ).rejects.toThrow("outside");
  });

  it("rejects malformed JSON and schema-invalid fixtures as usage errors", async () => {
    const fakeRepository = await mkdtemp(
      resolve(tmpdir(), "vgpu-factory-fixture-")
    );
    temporaryDirectories.push(fakeRepository);
    await writeFile(resolve(fakeRepository, "malformed.json"), "{no", "utf8");
    await writeFile(
      resolve(fakeRepository, "invalid.json"),
      JSON.stringify({ schemaVersion: 1 }),
      "utf8"
    );

    await expect(
      loadTriageFixture("malformed.json", { repositoryRoot: fakeRepository })
    ).rejects.toBeInstanceOf(FactoryUsageError);
    await expect(
      loadTriageFixture("invalid.json", { repositoryRoot: fakeRepository })
    ).rejects.toBeInstanceOf(FactoryUsageError);
  });

  it("rejects oversized fixture files", async () => {
    const fakeRepository = await mkdtemp(
      resolve(tmpdir(), "vgpu-factory-fixture-")
    );
    temporaryDirectories.push(fakeRepository);
    await writeFile(
      resolve(fakeRepository, "large.json"),
      " ".repeat(512_001),
      "utf8"
    );
    await expect(
      loadTriageFixture("large.json", { repositoryRoot: fakeRepository })
    ).rejects.toThrow("size limit");
  });
});

describe("validateNormalizedContext", () => {
  it("rejects mismatched source IDs, URLs, and unavailable capabilities", () => {
    const wrongSources = makeContext({ availableSourceIds: ["issue:123"] });
    expect(() => validateNormalizedContext(wrongSources)).toThrow(
      "availableSourceIds"
    );

    const noLabels = makeContext({
      capabilities: { labelsAvailable: false, duplicateSearchAvailable: true },
    });
    expect(() => validateNormalizedContext(noLabels)).toThrow(
      "cannot provide labels"
    );

    const noSearch = makeContext({
      capabilities: { labelsAvailable: true, duplicateSearchAvailable: false },
    });
    expect(() => validateNormalizedContext(noSearch)).toThrow(
      "cannot provide duplicate"
    );
  });
});
