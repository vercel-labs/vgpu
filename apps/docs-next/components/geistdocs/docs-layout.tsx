import { GeistdocsDocsLayout as PackageDocsLayout } from "@vercel/geistdocs/layout";
import type { ComponentProps } from "react";
import { config } from "@/lib/geistdocs/config";

// `children` is typed from `PackageDocsLayout`'s own prop type (instead of a
// plain `ReactNode` from "react") on purpose: the workspace resolves more
// than one semver-compatible @types/react across sibling packages (e.g.
// apps/docs on React 18), and depending on install/hoisting order `tsc` can
// end up comparing this file's own `ReactNode` against a structurally
// different `ReactNode` baked into @vercel/geistdocs's published types,
// which fails with "Property 'children' is missing in type ... ReactPortal".
// Sourcing the type directly from the consuming component's own props
// sidesteps that comparison entirely.
interface DocsLayoutProps {
  children: ComponentProps<typeof PackageDocsLayout>["children"];
  tree: ComponentProps<typeof PackageDocsLayout>["tree"];
}

export const DocsLayout = ({ tree, children }: DocsLayoutProps) => (
  <PackageDocsLayout
    config={config}
    containerProps={{
      className: "mx-auto max-w-[1448px] bg-background-200",
    }}
    tree={tree}
  >
    {children}
  </PackageDocsLayout>
);
