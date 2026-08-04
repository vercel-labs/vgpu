import Image from 'next/image';
import DynamicLink from 'fumadocs-core/dynamic-link';
import type { ExampleMeta } from '@/lib/example-meta';

interface ExampleCardProps {
  example: ExampleMeta;
}

/**
 * Landing-only example card. Same visual contract as the old
 * `apps/docs/components/example-card.tsx` (thumbnail, title, description,
 * gradient placeholder while no thumbnail exists) but rebuilt as a landing
 * component rather than trasplanted: the gallery (`/examples`, TGEIST-09) owns
 * its own card, and this ticket must not touch it.
 */
export function ExampleCard({ example }: ExampleCardProps) {
  return (
    <DynamicLink
      href={`/[lang]/examples/${example.slug}`}
      className="group block overflow-hidden rounded-lg border border-gray-4 bg-gray-1 transition-all hover:border-gray-5 hover:bg-gray-2"
    >
      <div className="relative aspect-video bg-black">
        {example.thumbnail ? (
          <Image
            src={example.thumbnail}
            alt={example.title}
            fill
            className="object-cover"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
            loading="eager"
          />
        ) : (
          <div className="absolute inset-0 bg-gradient-to-br from-blue-9/30 via-purple-9/20 to-black" />
        )}
      </div>
      <div className="p-4">
        <h3 className="mb-2 text-lg font-semibold text-gray-12 transition-colors group-hover:text-blue-9">
          {example.title}
        </h3>
        <p className="line-clamp-2 text-sm leading-relaxed text-gray-9">{example.description}</p>
      </div>
    </DynamicLink>
  );
}
