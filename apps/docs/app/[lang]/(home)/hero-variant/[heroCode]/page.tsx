import { notFound } from "next/navigation";
import { generatePermutations } from "flags/next";
import { translations } from "@/geistdocs";
import { heroCanvas, homepageFlags } from "@/flags";
import { HomePage } from "../../home-page";

export { homeMetadata as metadata } from "../../home-metadata";

export async function generateStaticParams() {
  if (!process.env.FLAGS_SECRET) return [];

  const codes = await generatePermutations(homepageFlags);
  return Object.keys(translations).flatMap((lang) =>
    codes.map((heroCode) => ({ lang, heroCode })),
  );
}

interface HeroVariantPageProps {
  readonly params: Promise<{ heroCode: string }>;
}

export default async function HeroVariantPage({
  params,
}: HeroVariantPageProps) {
  const { heroCode } = await params;

  try {
    const heroCanvasEnabled = await heroCanvas(heroCode, homepageFlags);
    return <HomePage heroCanvasEnabled={heroCanvasEnabled} />;
  } catch {
    notFound();
  }
}
