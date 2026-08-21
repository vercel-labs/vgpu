import type { Metadata } from "next";
import Link from "next/link";
import { siteUrl } from "@/lib/site";

const title = "Contact";
const description = "Where to ask for vgpu support and report reproducible bugs.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: siteUrl("/contact") },
  openGraph: { type: "article", title, description, url: siteUrl("/contact") },
};

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-16 pb-32">
      <h1 className="text-heading-40 font-medium tracking-tighter text-gray-1000">Contact and support</h1>
      <div className="mt-6 space-y-5 text-copy-16 leading-7 text-gray-900">
        <p>
          For usage questions, unexpected behavior, and bug reports, open an issue in the{" "}
          <a className="underline" href="https://github.com/vercel-labs/vgpu/issues">vgpu GitHub issue tracker</a>.
          Search existing issues first so related reports and workarounds stay together.
        </p>
        <p>A useful report includes the following diagnostic details:</p>
        <ul className="list-disc space-y-2 pl-6">
          <li>the vgpu, Node.js, browser, operating-system, and GPU/driver versions;</li>
          <li>a minimal reproduction or repository and the exact command that fails;</li>
          <li>complete error output, relevant shader diagnostics, and expected behavior;</li>
          <li>whether the same code runs in a browser, headless Node.js, or both.</li>
        </ul>
        <p>
          The <Link className="underline" href="/docs/cli">CLI documentation</Link> covers diagnostic
          commands, and the <Link className="underline" href="/docs">documentation index</Link> may
          already contain the relevant runtime setup or troubleshooting guide.
        </p>
      </div>
    </main>
  );
}
