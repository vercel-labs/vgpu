import { getPublicPath } from "@vercel/geistdocs/config";
import { Feed } from "feed";
import type { NextRequest } from "next/server";
import { title } from "@/geistdocs";
import { config } from "@/lib/geistdocs/config";
import { source } from "@/lib/geistdocs/source";
import { SITE_ORIGIN, siteUrl } from "@/lib/site";
const sitePath = getPublicPath("/", config.basePath);
const canonicalSiteUrl = new URL(sitePath, SITE_ORIGIN).toString();

export const revalidate = false;

export const GET = async (
  _req: NextRequest,
  { params }: RouteContext<"/[lang]/rss.xml">
) => {
  const { lang } = await params;
  const feed = new Feed({
    title,
    id: canonicalSiteUrl,
    link: canonicalSiteUrl,
    language: lang,
    copyright: `Copyright ${new Date().getFullYear()} Vercel. vgpu is licensed under MIT.`,
  });

  for (const page of source.getPages(lang)) {
    const data = page.data as {
      description?: string;
      lastModified?: Date;
      title?: string;
    };

    feed.addItem({
      id: page.url,
      title: data.title ?? page.url,
      description: data.description,
      link: siteUrl(getPublicPath(page.url, config.basePath)),
      date: new Date(data.lastModified ?? new Date()),
      author: [
        {
          name: "Vercel",
        },
      ],
    });
  }

  const rss = feed.rss2();

  return new Response(rss, {
    headers: {
      "Content-Type": "application/rss+xml",
    },
  });
};
