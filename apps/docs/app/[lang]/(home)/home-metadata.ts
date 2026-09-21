import type { Metadata } from "next";
import {
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_OG_IMAGE_PATH,
  siteUrl,
} from "@/lib/site";

const title = SITE_NAME;
const description = SITE_DESCRIPTION;

export const homeMetadata: Metadata = {
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
        url: siteUrl(SITE_OG_IMAGE_PATH),
        width: 1200,
        height: 630,
        alt: "vgpu — the WebGPU library designed for agents",
      },
    ],
  },
};
