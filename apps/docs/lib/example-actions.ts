import type { ExampleRecord } from "./examples-registry";
import { portableExampleSource } from "./example-export";
import { siteUrl } from "./site";

const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/gu;
const V0_WGSL_DEPENDENCY = "@vgpu/wgsl";

const v0NextConfig = `/** @type {import('next').NextConfig} */
const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  turbopack: {
    rules: {
      "*.wgsl": {
        loaders: ["@vgpu/wgsl/loader-webpack"],
        as: "*.js",
      },
    },
  },
  webpack(config) {
    config.module.rules.push({
      test: /\\.wgsl$/,
      loader: "@vgpu/wgsl/loader-webpack",
    })
    return config
  },
}

export default nextConfig
`;

const v0WgslTypes = `/// <reference types="@vgpu/wgsl/wgsl-types" />
`;

function packageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("node:")
  ) {
    return undefined;
  }

  if (specifier.startsWith("@")) {
    const [scope, name] = specifier.split("/");
    return scope && name ? `${scope}/${name}` : undefined;
  }

  return specifier.split("/")[0] || undefined;
}

function externalDependencies(example: ExampleRecord): string[] {
  const dependencies = new Set<string>([V0_WGSL_DEPENDENCY]);

  for (const { code } of example.sources) {
    for (const match of code.matchAll(IMPORT_SPECIFIER)) {
      const dependency = packageName(match[1]);
      if (dependency) dependencies.add(dependency);
    }
  }

  return [...dependencies].sort();
}

export function buildExamplePrompt(example: ExampleRecord): string {
  const { slug, title } = example.meta;

  return `Use the “${title}” vgpu example as a starting point for my project.

Pull the complete, verified source into the current workspace with:

\`\`\`bash
npx vgpu examples pull ${slug} --out ./${slug}
\`\`\`

Then inspect the downloaded files, install any required dependencies, and integrate the example into the existing app. Preserve its WebGPU behavior and resource cleanup, adapt only what the project needs, and explain the changes you make.`;
}

export function buildExampleV0RegistryItem(example: ExampleRecord) {
  const { description, slug, title } = example.meta;
  const dependencies = externalDependencies(example);

  return {
    $schema: "https://ui.shadcn.com/schema/registry-item.json",
    name: `vgpu-${slug}`,
    type: "registry:block",
    title,
    description,
    ...(dependencies.length > 0 ? { dependencies } : {}),
    files: [
      {
        path: "app/page.tsx",
        content: `import Example from "@/examples/${slug}/index";

export default function Page() {
  return (
    <main className="h-svh w-full overflow-hidden">
      <Example />
    </main>
  );
}
`,
        type: "registry:page",
        target: "app/page.tsx",
      },
      ...example.sources.map(({ code, name }) => ({
        path: `examples/${slug}/${name}`,
        content: portableExampleSource(code),
        type: name === "index.tsx" ? "registry:component" : "registry:file",
        target: `~/examples/${slug}/${name}`,
      })),
      {
        path: "next.config.mjs",
        content: v0NextConfig,
        type: "registry:file",
        target: "~/next.config.mjs",
      },
      {
        path: "wgsl-env.d.ts",
        content: v0WgslTypes,
        type: "registry:file",
        target: "~/wgsl-env.d.ts",
      },
    ],
    meta: {
      command: `npx vgpu examples pull ${slug} --out ./${slug}`,
      source: siteUrl(`/examples/${slug}/source.md`),
    },
  } as const;
}

export function buildV0OpenUrl(example: ExampleRecord): string {
  const { slug, title } = example.meta;
  const query = new URLSearchParams({
    title,
    prompt:
      "Use the provided app/page.tsx as the entry point. Preserve next.config.mjs and wgsl-env.d.ts so the included WGSL imports compile with Turbopack and webpack. Keep the example source files together and do not replace the WGSL modules with raw strings.",
    url: siteUrl(`/examples/${slug}/v0.json`),
  });
  return `https://v0.app/chat/api/open?${query.toString()}`;
}
