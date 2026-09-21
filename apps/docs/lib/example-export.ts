import { siteUrl } from "./site";

const PUBLIC_ASSET_PATH = /(["'`])\/((?:examples|models|ort)\/[^"'`]*)\1/gu;

export function portableExampleSource(code: string): string {
  return code.replace(PUBLIC_ASSET_PATH, (_match, quote: string, path: string) => {
    return `${quote}${siteUrl(`/${path}`)}${quote}`;
  });
}
