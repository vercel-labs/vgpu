import { expect, test } from "vitest";
import { buildSkill } from "../lib/docs/generate/skill.js";

const files = buildSkill();
const skill = files.get("SKILL.md") ?? "";

test("ships only a version-neutral router", () => {
  expect([...files.keys()]).toEqual(["SKILL.md"]);
  expect(skill).not.toContain("references/");
  expect(skill).not.toMatch(/^(?:vgpuVersion|gitSha|generatedAt):/gmu);
  expect(skill).not.toContain("API reference");
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
