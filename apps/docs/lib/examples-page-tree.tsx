import type * as PageTree from "fumadocs-core/page-tree";
// TGEIST-09b: verbatim data source (TGEIST-07), unmodified -- this file only
// projects it into a synthetic fumadocs page tree so `/examples` can reuse
// the same `DocsLayout`/sidebar chrome as `/docs`, replicating the old
// app's `ExamplesSidebar` (flat list, thumbnail + title, active state)
// within what the geistdocs sidebar component actually supports:
// per-item `icon` (rendered at icon size, not a big aspect-video thumb) and
// URL-based active-state highlighting. There is no grouping here because
// the old `ExamplesSidebar` had none either (plain flat list).
import { examplesMetadata } from "@/lib/examples-metadata";

function ExampleSidebarThumb({ thumbnail }: { thumbnail?: string }) {
  if (thumbnail) {
    // eslint-disable-next-line @next/next/no-img-element -- sidebar icon
    // slot, not a Next-optimized hero image; also unauthenticated static
    // asset so no benefit from next/image here.
    return (
      <img
        alt=""
        className="size-5 shrink-0 rounded-sm object-cover"
        decoding="async"
        fetchPriority="low"
        loading="lazy"
        src={thumbnail}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="block size-5 shrink-0 rounded-sm bg-gradient-to-br from-blue-700/50 via-purple-700/30 to-black"
    />
  );
}

export function buildExamplesPageTree(): PageTree.Root {
  return {
    name: "Examples",
    children: examplesMetadata.map((example) => ({
      type: "page",
      name: example.title,
      url: `/examples/${example.slug}`,
      icon: <ExampleSidebarThumb thumbnail={example.thumbnail} />,
    })),
  };
}
