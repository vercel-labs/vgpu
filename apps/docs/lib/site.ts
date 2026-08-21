export const SITE_ORIGIN = "https://vgpu.sh" as const;
export const SITE_NAME = "vgpu" as const;
export const SITE_DESCRIPTION = "The WebGPU library, designed for agents." as const;

export function siteUrl(path = "/"): string {
  return new URL(path, SITE_ORIGIN).toString();
}
