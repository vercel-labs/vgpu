import type { MetadataRoute } from "next";

import { source } from "@/lib/geistdocs/source";
import { examplesMetadata } from "@/lib/examples-metadata";
import { siteUrl } from "@/lib/site";

export const revalidate = false;

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: MetadataRoute.Sitemap = [];

  for (const page of source.getPages()) {
    const data = page.data as {
      lastModified?: Date;
    };

    pages.push({
      changeFrequency: "weekly" as const,
      lastModified: data.lastModified ? new Date(data.lastModified) : undefined,
      priority: 0.5,
      url: siteUrl(page.url),
    });
  }

  return [
    {
      changeFrequency: "monthly",
      priority: 1,
      url: siteUrl("/"),
    },
    {
      changeFrequency: "weekly",
      priority: 0.8,
      url: siteUrl("/examples"),
    },
    ...examplesMetadata.map((example) => ({
      changeFrequency: "monthly" as const,
      priority: 0.7,
      url: siteUrl(`/examples/${example.slug}`),
    })),
    {
      changeFrequency: "monthly",
      priority: 0.6,
      url: siteUrl("/about"),
    },
    {
      changeFrequency: "monthly",
      priority: 0.5,
      url: siteUrl("/contact"),
    },
    ...pages,
  ];
}
