import { describe, expect, it } from "vitest";
import { buildExamplePrompt, buildExampleV0RegistryItem, buildV0OpenUrl } from "./example-actions";
import { examples, getExample } from "./examples-registry";

const gradient = getExample("gradient");
if (!gradient) throw new Error("Missing gradient example fixture");

const publicAssetExamples = [
  {
    slug: "three-tsl",
    sourcePath: "/examples/three-tsl/sunset.exr",
  },
  {
    slug: "glass-fractal",
    sourcePath: "/examples/glass-fractal/rounded-tetrahedron.mesh?v=bevel-4",
  },
  {
    slug: "depth-estimation",
    sourcePath: "/models/depth/fastdepth-320x256.onnx",
  },
  {
    slug: "depth-estimation",
    sourcePath: "/ort/",
  },
  {
    slug: "air-painting",
    sourcePath: "/models/mediapipe-hands/palm-detector.onnx",
  },
  {
    slug: "mnist-classifier",
    sourcePath: "/models/mnist/mnist-12.onnx",
  },
] as const;

describe("example actions", () => {
  it("builds an agent prompt with the verified pull command and integration instructions", () => {
    const prompt = buildExamplePrompt(gradient);

    expect(prompt).toContain("npx vgpu examples pull gradient --out ./gradient");
    expect(prompt).toContain("install any required dependencies");
    expect(prompt).toContain("Preserve its WebGPU behavior and resource cleanup");
  });

  it("builds an explicit v0 page with its source and WGSL configuration", () => {
    const item = buildExampleV0RegistryItem(gradient);

    expect(item.$schema).toBe("https://ui.shadcn.com/schema/registry-item.json");
    expect(item.type).toBe("registry:block");
    expect(item.dependencies).toEqual(expect.arrayContaining(["@vgpu/wgsl", "react", "vgpu"]));
    expect(item.files).toHaveLength(gradient.sources.length + 3);
    expect(item.files[0]).toMatchObject({
      path: "app/page.tsx",
      target: "app/page.tsx",
      type: "registry:page",
    });
    expect(item.files[0].content).toContain(
      'import Example from "@/examples/gradient/index"',
    );
    expect(item.files[1]).toMatchObject({
      path: "examples/gradient/index.tsx",
      target: "~/examples/gradient/index.tsx",
      type: "registry:component",
      content: gradient.sources[0].code,
    });
    expect(item.files).toContainEqual(
      expect.objectContaining({
        path: "next.config.mjs",
        target: "~/next.config.mjs",
        type: "registry:file",
      }),
    );
    const nextConfig = item.files.find((file) => file.path === "next.config.mjs")?.content;
    expect(nextConfig).toContain('loaders: ["@vgpu/wgsl/loader-webpack"]');
    expect(nextConfig).toContain("webpack(config)");
    expect(item.files).toContainEqual(
      expect.objectContaining({
        path: "wgsl-env.d.ts",
        target: "~/wgsl-env.d.ts",
      }),
    );
    expect(item.files.find((file) => file.path === "wgsl-env.d.ts")?.content).toContain(
      '@vgpu/wgsl/wgsl-types',
    );
  });

  it("publishes a default entry component for every example", () => {
    for (const example of examples) {
      const entry = example.sources.find(({ name }) => name === "index.tsx");

      expect(entry?.code, `${example.meta.slug}/index.tsx`).toContain("export default Example;");
    }
  });

  it.each(publicAssetExamples)(
    "points $slug public assets at vgpu.sh in the v0 registry only",
    ({ slug, sourcePath }) => {
      const example = getExample(slug);
      if (!example) throw new Error(`Missing ${slug} example fixture`);

      const source = example.sources.find(({ code }) => code.includes(sourcePath));
      expect(source?.code).toContain(sourcePath);

      const item = buildExampleV0RegistryItem(example);
      const v0Source = item.files.find(
        ({ path }) => path === `examples/${slug}/${source?.name}`,
      )?.content;

      expect(v0Source).toContain(`https://vgpu.sh${sourcePath}`);
      expect(source?.code).not.toContain(`https://vgpu.sh${sourcePath}`);
    },
  );

  it("does not publish root-relative public asset URLs to v0", () => {
    const rootRelativePublicAsset = /(["'`])\/(?:examples|models|ort)\//u;

    for (const example of examples) {
      const item = buildExampleV0RegistryItem(example);

      for (const file of item.files) {
        expect(file.content, file.path).not.toMatch(rootRelativePublicAsset);
      }
    }
  });

  it("opens v0 with the public registry endpoint", () => {
    const url = new URL(buildV0OpenUrl(gradient));

    expect(url.origin + url.pathname).toBe("https://v0.app/chat/api/open");
    expect(url.searchParams.get("url")).toBe("https://vgpu.sh/examples/gradient/v0.json");
    expect(url.searchParams.get("title")).toBe("Simple Gradient");
    expect(url.searchParams.get("prompt")).toContain("Preserve next.config.mjs");
    expect(url.searchParams.get("prompt")?.length).toBeLessThanOrEqual(500);
  });
});
