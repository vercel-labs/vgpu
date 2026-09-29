import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { expect, test } from "vitest";
import { buildSkill } from "../lib/docs/generate/skill.js";
import { generateDocs } from "../lib/docs/generate/generate.js";

const files = buildSkill();
const skill = files.get("SKILL.md") ?? "";

test("generates only a version-neutral router", () => {
  expect([...files.keys()]).toEqual(["SKILL.md"]);
  expect(skill).not.toContain("references/");
  expect(skill).not.toMatch(/^(?:vgpuVersion|gitSha|generatedAt):/gmu);
  expect(skill).not.toContain("API reference");
});

test("regeneration preserves authored Blender resources and prunes stale generated files", () => {
  const root = resolve(import.meta.dirname, "../../..");
  const scratch = mkdtempSync(join(tmpdir(), "vgpu-blender-skill-"));
  const skillDir = join(scratch, "skill");
  try {
    cpSync(join(root, "skills/vgpu"), skillDir, { recursive: true });
    const authoredPath = join(skillDir, "blender/references/local-review.md");
    writeFileSync(authoredPath, "# Authored review notes\n");
    writeFileSync(join(skillDir, "stale-generated.md"), "obsolete\n");
    const options = { root, skillDir, manifestOut: join(scratch, "manifest.js") };
    generateDocs(options);
    generateDocs(options);

    expect(existsSync(join(skillDir, "stale-generated.md"))).toBe(false);
    expect(readFileSync(authoredPath, "utf8")).toBe("# Authored review notes\n");
    expect(readFileSync(join(skillDir, "SKILL.md"), "utf8")).toBe(skill);

    // Follow links from the installable entrypoint, without access to the source repository.
    // This catches missing references and links that accidentally escape the skill folder.
    const visited = new Set<string>();
    const visit = (path: string) => {
      if (visited.has(path)) return;
      visited.add(path);
      const content = readFileSync(path, "utf8");
      for (const [, target] of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
        if (/^(?:https?:|#)/u.test(target)) continue;
        const linkedPath = resolve(dirname(path), target.split("#")[0]);
        expect(linkedPath.startsWith(`${skillDir}${sep}`)).toBe(true);
        visit(linkedPath);
      }
    };
    visit(join(skillDir, "SKILL.md"));
    expect(visited.has(join(skillDir, "blender/index.md"))).toBe(true);
    expect(visited.has(join(skillDir, "blender/references/shape-and-assembly.md"))).toBe(true);
    expect(visited.has(join(skillDir, "blender/references/baking-and-diagnostics.md"))).toBe(true);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("keeps a project pinned to its local CLI and bundled corpus", () => {
  const localRoute = skill.slice(
    skill.indexOf("## Select the package version"),
    skill.indexOf("If a package manifest or lockfile selects")
  );
  expect(localRoute).toContain("pnpm exec vgpu --version");
  expect(localRoute).toContain("npm exec --no -- vgpu --version");
  expect(localRoute).not.toContain("npm exec --offline");
  expect(localRoute).toContain("project-local `vgpu` executable");
  expect(localRoute).not.toContain("vgpu@latest");
  expect(localRoute).toContain("do not use them for local version discovery");

  expect(skill).toContain("pnpm exec vgpu docs --help");
  expect(skill).toContain("pnpm exec vgpu docs find");
  expect(skill).toContain("pnpm exec vgpu docs grep");
  expect(skill).toContain("pnpm exec vgpu docs cat");
  expect(skill).toContain("same project-local executable");
  expect(skill).toContain(
    "retain `npm exec --no -- vgpu` for every docs command"
  );
});

test("uses explicit stable fallback when no local package exists and keeps prereleases opt-in", () => {
  const selectedButMissingRoute = skill.slice(
    skill.indexOf("If a package manifest or lockfile selects"),
    skill.indexOf("Only when neither the")
  );
  expect(selectedButMissingRoute).toContain("vgpu@<selected-version>");
  expect(selectedButMissingRoute).not.toContain("vgpu@latest");

  expect(skill).toContain("npx skills add vercel-labs/vgpu");
  expect(skill).not.toMatch(/vercel-labs\/vgpu#/u);
  expect(skill).toContain("npx -y vgpu@latest docs");
  expect(skill).toContain("vgpu@next");
  expect(skill).toMatch(
    /only when the user or\s+the existing project explicitly selected that prerelease/u
  );
  expect(skill).not.toMatch(/^npx(?: -y)? vgpu docs/gmu);
});
