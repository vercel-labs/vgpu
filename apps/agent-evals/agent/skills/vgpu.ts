import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { defineDynamic, defineSkill } from "eve/skills";

const TASK_ID = "scene-quaternion-keyframes";

interface SkillOptions {
  skillPath?: string;
  expectedSha256?: string;
  expectedSceneSha256?: string;
}

export function readTaskVgpuSkill(taskId: string | undefined, options: SkillOptions = {}) {
  if (taskId !== TASK_ID) return null;
  const skillPath = options.skillPath ?? process.env.VGPU_EVALS_VGPU_SKILL_PATH;
  if (!skillPath) throw new Error("VGPU_EVALS_VGPU_SKILL_PATH is required for scene-quaternion-keyframes");
  const markdown = readFileSync(skillPath, "utf8");
  const sha256 = createHash("sha256").update(markdown).digest("hex");
  const expectedSha256 = options.expectedSha256 ?? process.env.VGPU_EVALS_VGPU_SKILL_SHA256;
  if (expectedSha256 && sha256 !== expectedSha256) {
    throw new Error(`vgpu skill hash mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
  const description = skillDescription(markdown);
  if (!description) throw new Error("vgpu skill has no description frontmatter");
  const sceneMarkdown = readFileSync(join(dirname(skillPath), "scene.md"), "utf8");
  const sceneSha256 = createHash("sha256").update(sceneMarkdown).digest("hex");
  const expectedSceneSha256 = options.expectedSceneSha256 ?? process.env.VGPU_EVALS_VGPU_SCENE_SKILL_SHA256;
  if (expectedSceneSha256 && sceneSha256 !== expectedSceneSha256) {
    throw new Error(`vgpu scene skill hash mismatch: expected ${expectedSceneSha256}, got ${sceneSha256}`);
  }
  return { description, markdown, sha256, sceneSha256, files: { "scene.md": sceneMarkdown } };
}

function skillDescription(markdown: string): string | undefined {
  const frontmatter = markdown.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/)?.[1];
  if (!frontmatter) return undefined;
  const lines = frontmatter.split("\n");
  const index = lines.findIndex((line) => line.startsWith("description:"));
  if (index === -1) return undefined;
  const value = lines[index]!.slice("description:".length).trim();
  if (value === ">" || value === ">-" || value === "|" || value === "|-") {
    const folded: string[] = [];
    for (const line of lines.slice(index + 1)) {
      if (!/^\s/.test(line)) break;
      folded.push(line.trim());
    }
    return folded.join(" ");
  }
  return value.replace(/^(["'])(.*)\1$/, "$2");
}

export default defineDynamic({
  events: {
    "session.started": () => {
      const skill = readTaskVgpuSkill(process.env.VGPU_EVALS_TASK);
      return skill ? defineSkill({ description: skill.description, markdown: skill.markdown, files: skill.files }) : null;
    },
  },
});
