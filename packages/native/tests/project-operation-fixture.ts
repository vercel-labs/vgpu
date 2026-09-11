import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { MetalConfiguration } from "../src/tooling/configuration.ts";

const docs = new URL(
  "../../../docs/topics/native/macos/metal/",
  import.meta.url
);
export const projectConfiguration: MetalConfiguration = JSON.parse(
  (
    await snippets(
      "tooling/native-macos-metal-tooling-configuration.docs.md",
      "json"
    )
  )[0]
);
export const projectSources = await snippets(
  "tooling/native-macos-metal-tooling-sources.docs.md",
  "wgsl"
);
const gradient = (
  await snippets("native-macos-metal-uniforms.docs.md", "wgsl")
)[0];

export async function projectFixture() {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "vgpu-project-operation-"))
  );
  const configurationPath = join(directory, "vgpu.native.json");
  for (const [path, source] of Object.entries({
    "vgpu.native.json": JSON.stringify(projectConfiguration),
    "shaders/gradient.wgsl": gradient,
    "shaders/count.wgsl": projectSources[0],
    "shaders/dimensions.wgsl": projectSources[1],
  })) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), source);
  }
  return {
    directory,
    configurationPath,
    outputPath: join(directory, projectConfiguration.output),
  };
}

async function snippets(path: string, language: string): Promise<string[]> {
  const guide = await readFile(new URL(path, docs), "utf8");
  return [
    ...guide.matchAll(
      new RegExp("```" + language + "\\n([\\s\\S]*?)\\n```", "gu")
    ),
  ].map((match) => match[1]);
}
