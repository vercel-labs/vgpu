import DynamicLink from "fumadocs-core/dynamic-link";
import { cn } from "@/lib/utils";
import { InlineCode } from "./inline-code";

// Same copy as the old landing (apps/docs/app/page.tsx:docLinks).
const docLinks: [href: string, title: string, description: string][] = [
  [
    "/docs/get-started",
    "Getting Started",
    "Install `vgpu` and render with `init()`.",
  ],
  [
    "/docs/concepts",
    "Core Concepts",
    "Learn Gpu, set(), targets, frames, bundles, and adapters.",
  ],
  [
    "/docs/reference",
    "API Reference",
    "Package map and generated topic pages.",
  ],
  ["/examples", "Examples", "Live WebGPU demos with read-only source views."],
];

export function DocsLinksSection() {
  return (
    <section className="mb-24">
      <h2 className="mb-10 text-pretty text-2xl text-gray-1000 md:text-3xl">
        Explore the Docs
      </h2>
      <div className="grid gap-4 md:grid-cols-2">
        {docLinks.map(([href, title, description]) => (
          <DynamicLink
            key={href}
            href={`/[lang]${href}`}
            className={cn("interactive-card p-6")}
            prefetch={false}
          >
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-pretty text-gray-1000">{title} →</h3>
            </div>
            <p className="text-pretty text-sm text-gray-900">
              <InlineCode text={description} />
            </p>
          </DynamicLink>
        ))}
      </div>
      <p className="mt-6 text-pretty text-sm text-gray-900">
        Building agent tooling? Read the{" "}
        <DynamicLink
          className="underline"
          href="/[lang]/docs/examples-api"
          prefetch={false}
        >
          vgpu Examples API reference
        </DynamicLink>{" "}
        or inspect its{" "}
        <a className="underline" href="/openapi.json">
          OpenAPI 3.1 description
        </a>
        .
      </p>
    </section>
  );
}
