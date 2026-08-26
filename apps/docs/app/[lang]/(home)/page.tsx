import type { Metadata } from "next";
import { AgentCommandSection } from "./components/agent-command-section";
import { DocsLinksSection } from "./components/docs-links-section";
import { ExamplesSection } from "./components/examples-section";
import { Hero } from "./components/hero";
import { OneShaderEverySurfaceSection } from "./components/one-shader-every-surface-section";
import { ShaderCodeScalesSection } from "./components/shader-code-scales-section";
import "./hero-solo.css";
import { SITE_DESCRIPTION, SITE_IDENTITY_URLS, SITE_NAME, siteUrl } from "@/lib/site";

// Landing metadata + body copy carried over unchanged from the old
// `apps/docs/app/page.tsx` (this ticket rebuilds the chrome, not the text —
// see TGEIST-10).
const title = SITE_NAME;
const description = SITE_DESCRIPTION;

export const metadata: Metadata = {
  title: { absolute: title },
  description,
  alternates: { canonical: siteUrl("/") },
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title,
    description,
    url: siteUrl("/"),
    images: [
      {
        url: siteUrl("/opengraph-image"),
        width: 1200,
        height: 630,
        alt: "vgpu — the WebGPU library designed for agents",
      },
    ],
  },
};

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteUrl("/")}#website`,
      name: SITE_NAME,
      url: siteUrl("/"),
      description,
      publisher: { "@id": "https://vercel.com/#organization" },
      sameAs: SITE_IDENTITY_URLS,
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${siteUrl("/")}#source`,
      name: SITE_NAME,
      description,
      url: siteUrl("/"),
      codeRepository: "https://github.com/vercel-labs/vgpu",
      downloadUrl: "https://www.npmjs.com/package/vgpu",
      license: "https://github.com/vercel-labs/vgpu/blob/main/LICENSE",
      programmingLanguage: ["TypeScript", "WGSL"],
      runtimePlatform: ["Web browsers", "Node.js", "Serverless runtimes"],
      sameAs: SITE_IDENTITY_URLS,
      publisher: {
        "@type": "Organization",
        "@id": "https://vercel.com/#organization",
        name: "Vercel",
        url: "https://vercel.com",
      },
    },
  ],
};

const HomePage = () => (
  <>
    <script
      dangerouslySetInnerHTML={{ __html: JSON.stringify(structuredData).replace(/</gu, "\\u003c") }}
      type="application/ld+json"
    />
    {/* Sans, like the rest of the site — matches the old landing's choice not to
        opt any body copy into Geist Serif. */}
    <div>
      <Hero />
      <main className="mx-auto max-w-6xl px-6 pb-16 lg:px-12 lg:pb-20">
        <OneShaderEverySurfaceSection />
        <ShaderCodeScalesSection />
        <AgentCommandSection />
        <ExamplesSection />
        <DocsLinksSection />
      </main>
    </div>
  </>
);

export default HomePage;
