import { vercelAdapter } from "@flags-sdk/vercel";
import { flag } from "flags/next";

const heroCanvasDecision = process.env.FLAGS
  ? { adapter: vercelAdapter() }
  : { decide: () => true };

export const heroCanvas = flag<boolean>({
  key: "hero-canvas",
  ...heroCanvasDecision,
  defaultValue: true,
  description: "Release the prism hero canvas",
  options: [
    { value: false, label: "Hidden" },
    { value: true, label: "Released" },
  ],
});

export const homepageFlags = [heroCanvas] as const;

export const flagDefinitions = { heroCanvas };
