import { AgentCommandSection } from "./components/agent-command-section";
import { DocsLinksSection } from "./components/docs-links-section";
import { ExamplesSection } from "./components/examples-section";
import { Hero } from "./components/hero";
import { OneShaderEverySurfaceSection } from "./components/one-shader-every-surface-section";
import { ShaderCodeScalesSection } from "./components/shader-code-scales-section";
import "./hero-solo.css";
import {
  SITE_DESCRIPTION,
  SITE_IDENTITY_URLS,
  SITE_NAME,
  siteUrl,
} from "@/lib/site";

const structuredData = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": `${siteUrl("/")}#website`,
      name: SITE_NAME,
      url: siteUrl("/"),
      description: SITE_DESCRIPTION,
      publisher: { "@id": "https://vercel.com/#organization" },
      sameAs: SITE_IDENTITY_URLS,
    },
    {
      "@type": "SoftwareSourceCode",
      "@id": `${siteUrl("/")}#source`,
      name: SITE_NAME,
      description: SITE_DESCRIPTION,
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

interface HomePageProps {
  readonly heroCanvasEnabled: boolean;
}

export function HomePage({ heroCanvasEnabled }: HomePageProps) {
  return (
    <>
      <script
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(structuredData).replace(/</gu, "\\u003c"),
        }}
        type="application/ld+json"
      />
      {/* Sans, like the rest of the site — matches the old landing's choice not to
          opt any body copy into Geist Serif. */}
      <div>
        <Hero canvasEnabled={heroCanvasEnabled} />
        <main className="mx-auto max-w-6xl px-6 pb-16 pt-24 min-[768px]:pt-0 lg:px-12 lg:pb-20">
          <OneShaderEverySurfaceSection />
          <ShaderCodeScalesSection />
          <AgentCommandSection />
          <ExamplesSection />
          <DocsLinksSection />
        </main>
      </div>
    </>
  );
}
