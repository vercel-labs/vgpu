import { getPublicPath } from "@vercel/geistdocs/config";
import { Feed } from "feed";
import type { NextRequest } from "next/server";
import { title } from "@/geistdocs";
import { config } from "@/lib/geistdocs/config";
import { source } from "@/lib/geistdocs/source";

const protocol = process.env.NODE_ENV === "production" ? "https" : "http";
const baseUrl = `${protocol}://${process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL}`;
const sitePath = getPublicPath("/", config.basePath);
const siteUrl = sitePath === "/" ? baseUrl : `${baseUrl}${sitePath}`;

export const revalidate = false;

export const GET = async (
  _req: NextRequest,
  { params }: RouteContext<"/[lang]/rss.xml">
) => {
  const { lang } = await params;
  const feed = new Feed({
    title,
    id: siteUrl,
    link: siteUrl,
    language: lang,
    copyright: `All rights reserved ${new Date().getFullYear()}, Vercel`,
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
      link: `${baseUrl}${getPublicPath(page.url, config.basePath)}`,
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
