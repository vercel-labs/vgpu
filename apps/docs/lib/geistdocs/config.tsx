import { defineConfig } from "@vercel/geistdocs/config";
import {
  agent,
  basePath,
  github,
  Logo,
  nav,
  navbarVariant,
  prompt,
  siteId,
  suggestions,
  title,
  translations,
} from "@/geistdocs";

export const config = defineConfig({
  title,
  agent,
  defaultLanguage: "en",
  logo: <Logo />,
  github,
  nav,
  navbarVariant,
  basePath,
  siteId,
  translations,
  content: [{ id: "docs", label: "Docs", dir: "content/docs", route: "/docs" }],
  ai: {
    prompt,
    suggestions,
  },
});
