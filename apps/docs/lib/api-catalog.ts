import { siteUrl } from "./site";

export const API_CATALOG_PROFILE = "https://www.rfc-editor.org/info/rfc9727" as const;
export const API_CATALOG_CONTENT_TYPE =
  `application/linkset+json; profile="${API_CATALOG_PROFILE}"` as const;

export const apiCatalogDocument = {
  linkset: [
    {
      anchor: siteUrl("/.well-known/api-catalog"),
      item: [
        {
          href: siteUrl("/.well-known/vgpu-examples.json"),
          type: "application/json",
        },
      ],
    },
    {
      anchor: siteUrl("/.well-known/vgpu-examples.json"),
      "service-desc": [
        {
          href: siteUrl("/openapi.json"),
          type: "application/json",
        },
      ],
      "service-doc": [
        {
          href: siteUrl("/docs/examples-api"),
          type: "text/html",
        },
      ],
    },
  ],
} as const;
