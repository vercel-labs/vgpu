import Image from "next/image";
import DynamicLink from "fumadocs-core/dynamic-link";
import type { ExampleMeta } from "@/lib/example-meta";
import { cn } from "@/lib/utils";

interface ExampleCardProps {
  example: ExampleMeta;
}

/**
 * Landing-only example card. Same visual contract as the old
 * `apps/docs/components/example-card.tsx` (thumbnail, title, description,
 * gradient placeholder while no thumbnail exists) but rebuilt as a landing
 * component rather than trasplanted: the gallery (`/examples`, TGEIST-09) owns
 * its own card.
 */
export function ExampleCard({ example }: ExampleCardProps) {
  return (
    <DynamicLink
      href={`/[lang]/examples/${example.slug}`}
      className={cn("interactive-card block overflow-hidden")}
      prefetch={false}
    >
      <div className="relative aspect-video bg-black">
        {example.thumbnail ? (
          <Image
            src={example.thumbnail}
            alt={example.title}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            fetchPriority="low"
            loading="lazy"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-9/30 via-purple-9/20 to-black" />
        )}
      </div>
      <div className="p-4">
        <h3 className="mb-2 text-pretty text-lg font-semibold text-gray-1000">
          {example.title}
        </h3>
        <p className="line-clamp-2 text-pretty text-sm leading-relaxed text-gray-900">
          {example.description}
        </p>
      </div>
    </DynamicLink>
  );
}
