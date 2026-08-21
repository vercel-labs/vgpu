import type { Metadata } from "next";
import Link from "next/link";
import { siteUrl } from "@/lib/site";

const title = "About";
const description = "About vgpu, its maintainers, source, package, and open-source license.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: siteUrl("/about") },
  openGraph: { type: "article", title, description, url: siteUrl("/about") },
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 pb-32">
      <h1 className="text-heading-40 font-medium tracking-tighter text-gray-1000">About vgpu</h1>
      <div className="mt-6 space-y-5 text-copy-16 leading-7 text-gray-900">
        <p>
          vgpu is a small, composable WebGPU library for rendering in web browsers and headless in
          Node.js. It treats WGSL modules like TypeScript imports and is designed to be practical for
          both developers and coding agents.
        </p>
        <p>
          The project is maintained by Vercel and developed in the open. Its source, history, and
          contribution workflow live in the{" "}
          <a className="underline" href="https://github.com/vercel-labs/vgpu">GitHub repository</a>.
          The installable package is published as{" "}
          <a className="underline" href="https://www.npmjs.com/package/vgpu">vgpu on npm</a>.
        </p>
        <p>
          vgpu is open-source software distributed under the{" "}
          <a className="underline" href="https://github.com/vercel-labs/vgpu/blob/main/LICENSE">MIT License</a>.
          See the <Link className="underline" href="/docs">documentation</Link> to get started or the{" "}
          <Link className="underline" href="/examples">examples</Link> to inspect working projects.
        </p>
      </div>
    </main>
  );
}
