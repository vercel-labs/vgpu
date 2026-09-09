import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEveInvocation } from "../src/eve-invocation.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function createSource(): Promise<string> {
  const appRoot = await mkdtemp(join(tmpdir(), "vgpu-invocation-test-"));
  temporaryDirectories.push(appRoot);
  const files = {
    "package.json": '{"name":"factory-test","type":"module"}',
    "tsconfig.json": '{"compilerOptions":{"strict":true}}',
    "agent/instructions.md": "Trusted agent instructions.",
    "agent/lib/schema.ts": "export const schema = {};",
    "src/prompt.ts": "export const prompt = 'trusted prompt';",
    "evals/triage.eval.ts": "import '../src/prompt.ts';",
    "evals/fixtures/bug.json": '{"title":"Synthetic fixture"}',
  };
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(appRoot, relativePath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, contents);
  }
  await mkdir(join(appRoot, "node_modules"));
  return appRoot;
}

describe("createEveInvocation", () => {
  it("copies the agent and evaluation inputs while sharing installed dependencies", async () => {
    const sourceAppRoot = await createSource();
    const invocation = await createEveInvocation(sourceAppRoot);
    temporaryDirectories.push(invocation.appRoot);

    for (const relativePath of [
      "package.json",
      "tsconfig.json",
      "agent/instructions.md",
      "agent/lib/schema.ts",
      "src/prompt.ts",
      "evals/triage.eval.ts",
      "evals/fixtures/bug.json",
    ]) {
      expect(
        await readFile(join(invocation.appRoot, relativePath), "utf8")
      ).toBe(await readFile(join(sourceAppRoot, relativePath), "utf8"));
    }
    expect(await realpath(join(invocation.appRoot, "node_modules"))).toBe(
      await realpath(join(sourceAppRoot, "node_modules"))
    );

    await writeFile(join(sourceAppRoot, "agent/instructions.md"), "Changed");
    expect(
      await readFile(join(invocation.appRoot, "agent/instructions.md"), "utf8")
    ).toBe("Trusted agent instructions.");
  });

  it("excludes dotenv files and previously persisted state at every copied level", async () => {
    const sourceAppRoot = await createSource();
    const excludedPaths = [
      ".env.local",
      ".eve/.workflow-data/runs/old.json",
      "README.md",
      "agent/.env",
      "src/.env.test",
      "evals/.eve/old-result.json",
      "agent/.workflow-data/old-run.json",
      "src/node_modules/stale-dependency/index.js",
    ];
    for (const relativePath of excludedPaths) {
      const path = join(sourceAppRoot, relativePath);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, "Private historical input.");
    }

    const invocation = await createEveInvocation(sourceAppRoot);
    temporaryDirectories.push(invocation.appRoot);

    expect((await readdir(invocation.appRoot)).sort()).toEqual([
      "agent",
      "evals",
      "node_modules",
      "package.json",
      "src",
      "tsconfig.json",
    ]);
    for (const relativePath of excludedPaths) {
      await expect(
        readFile(join(invocation.appRoot, relativePath))
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(sourceAppRoot, relativePath), "utf8")).toBe(
        "Private historical input."
      );
    }
  });

  it("keeps artifacts private and never reopens a previous invocation's workflow state", async () => {
    const sourceAppRoot = await createSource();
    const first = await createEveInvocation(sourceAppRoot);
    temporaryDirectories.push(first.appRoot);
    const previousRun = join(
      first.appRoot,
      ".eve/.workflow-data/runs/old.json"
    );
    await mkdir(join(previousRun, ".."), { recursive: true });
    await writeFile(previousRun, '{"status":"running"}');

    const second = await createEveInvocation(sourceAppRoot);
    temporaryDirectories.push(second.appRoot);

    expect(second.appRoot).not.toBe(first.appRoot);
    expect((await stat(first.appRoot)).mode & 0o777).toBe(0o700);
    expect((await stat(second.appRoot)).mode & 0o777).toBe(0o700);
    await expect(
      readFile(join(second.appRoot, ".eve/.workflow-data/runs/old.json"))
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(previousRun, "utf8")).toBe('{"status":"running"}');
  });

  it("rejects authored symlinks instead of linking an invocation to external source or state", async () => {
    const sourceAppRoot = await createSource();
    await writeFile(
      join(sourceAppRoot, "historical-state.json"),
      "Private state."
    );
    await symlink(
      join(sourceAppRoot, "historical-state.json"),
      join(sourceAppRoot, "agent/lib/linked.json")
    );

    const creation = createEveInvocation(sourceAppRoot).then((invocation) => {
      temporaryDirectories.push(invocation.appRoot);
      return invocation;
    });

    await expect(creation).rejects.toThrow("symbolic link");
    expect(
      await readFile(join(sourceAppRoot, "historical-state.json"), "utf8")
    ).toBe("Private state.");
  });
});
