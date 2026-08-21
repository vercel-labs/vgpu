import type { Metadata } from "next";
import { DocsLayout } from "@/components/geistdocs/docs-layout";
import { buildExamplesPageTree } from "@/lib/examples-page-tree";

// TGEIST-09b: restores a sidebar for `/examples`, replicating (within what
// geistdocs' sidebar component supports) the old app's `ExamplesSidebar`:
// a flat list of all examples with a small thumbnail + title, and the
// active item highlighted. Reuses the same `DocsLayout` wrapper /docs uses
// (`components/geistdocs/docs-layout.tsx`) with a *synthetic* page tree
// built from `examplesMetadata` (verbatim data, TGEIST-07) instead of a
// `content/docs/**` + `meta.json` source -- this route still isn't part of
// the docs content pipeline, it just borrows its chrome.
export const metadata: Metadata = {
  title: "Examples",
  description: "Interactive WebGPU examples built with vgpu.",
};

export default function ExamplesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-background-200">
      <DocsLayout tree={buildExamplesPageTree()}>
        {/* DocsLayout's grid places children by named area ("sidebar main
            toc"); without an explicit area this content auto-flows into the
            sidebar column, which collapses to 0px on mobile where the
            sidebar is hidden. */}
        <div className="min-w-0 [grid-area:main]">{children}</div>
      </DocsLayout>
    </div>
  );
}
