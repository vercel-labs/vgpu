import "../global.css";
import type { Metadata } from "next";
import { getPublicPath } from "@vercel/geistdocs/config";
import { Footer } from "@vercel/geistdocs/footer";
import { Navbar } from "@vercel/geistdocs/navbar";
import { GeistdocsProvider } from "@/components/geistdocs/provider";
import { config } from "@/lib/geistdocs/config";
import { mono, sans } from "@/lib/geistdocs/fonts";
import { cn } from "@/lib/utils";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_ORIGIN,
  localizedSitePath,
  siteUrl,
} from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_ORIGIN),
  title: {
    default: SITE_NAME,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    siteName: SITE_NAME,
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
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

const Layout = async ({ children, params }: LayoutProps<"/[lang]">) => {
  const { lang } = await params;

  return (
    <html
      className={cn(sans.variable, mono.variable, "antialiased")}
      lang={lang}
      suppressHydrationWarning
    >
      <body>
        <GeistdocsProvider basePath={config.basePath} lang={lang}>
          <Navbar config={config} />
          {children}
          <Footer />
          <nav
            aria-label="vgpu project links"
            className="mx-auto flex max-w-[1448px] items-center gap-4 px-6 pb-8 text-sm text-gray-900"
          >
            <a
              className="transition-colors hover:text-gray-1000"
              href={getPublicPath(localizedSitePath("/about", lang), config.basePath)}
            >
              About
            </a>
            <a
              className="transition-colors hover:text-gray-1000"
              href={getPublicPath(localizedSitePath("/contact", lang), config.basePath)}
            >
              Contact
            </a>
          </nav>
        </GeistdocsProvider>
      </body>
    </html>
  );
};

export default Layout;
