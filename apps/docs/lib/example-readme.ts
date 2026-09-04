import type { ExampleRecord } from "./examples-registry";
import { portableExampleSource } from "./example-export";
import { siteUrl } from "./site";

function backtickFence(value: string, minimumLength: number): string {
  let longestRun = 0;
  for (const [run] of value.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, run.length);
  }
  return "`".repeat(Math.max(minimumLength, longestRun + 1));
}

function inlineCode(value: string): string {
  const fence = backtickFence(value, 1);
  return `${fence}${value}${fence}`;
}

function fencedSource(code: string, language: string): string {
  const fence = backtickFence(code, 3);
  const normalizedCode = code.endsWith("\n") ? code : `${code}\n`;
  return `${fence}${language}\n${normalizedCode}${fence}`;
}

export function buildExampleReadme(example: ExampleRecord): string {
  const { description, slug, title } = example.meta;
  const files = example.sources
    .map(({ name }) => `- ${inlineCode(name)}`)
    .join("\n");

  return `# ${title}

${description}

## Download

Download the complete verified example source:

\`\`\`bash
npx vgpu examples pull ${slug} --out ./${slug}
\`\`\`

## Explore

- [Interactive example](${siteUrl(`/examples/${slug}`)})
- [Fullscreen preview](${siteUrl(`/preview/${slug}`)})
- [Complete source](${siteUrl(`/examples/${slug}/source.md`)})

## Included files

${files}
`;
}

export function buildExampleSourceMarkdown(example: ExampleRecord): string {
  const files = example.sources
    .map(
      ({ code, lang, name }) =>
        `## ${inlineCode(name)}\n\n${fencedSource(portableExampleSource(code), lang)}`,
    )
    .join("\n\n");

  return `# ${example.meta.title} source

${files}
`;
}
