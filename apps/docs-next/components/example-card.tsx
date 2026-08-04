import Image from "next/image";
import Link from "next/link";
import { Badge } from "@vercel/geistdocs/components/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@vercel/geistdocs/components/card";
import type { ExampleMeta } from "@/lib/example-meta";

// TGEIST-09: chrome for the `/examples` gallery is rehecho with geistdocs
// primitives (`Card`, `Badge`) -- the data shown (title, description,
// thumbnail, tags/capabilities) comes verbatim from `examples-metadata.ts`
// (TGEIST-07), unmodified by this component.
interface ExampleCardProps {
  example: ExampleMeta;
}

const MAX_VISIBLE_TAGS = 3;

export function ExampleCard({ example }: ExampleCardProps) {
  return (
    <Link className="block no-underline" href={`/examples/${example.slug}`}>
      <Card className="group h-full gap-0 overflow-hidden p-0 transition-colors hover:border-gray-alpha-600">
        <div className="relative aspect-video w-full overflow-hidden bg-gray-1000">
          {example.thumbnail ? (
            <Image
              alt={example.title}
              className="object-cover"
              fill
              loading="eager"
              sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 33vw"
              src={example.thumbnail}
            />
          ) : (
            <div className="absolute inset-0 bg-gradient-to-br from-blue-700/40 via-purple-700/20 to-black" />
          )}
        </div>
        <CardHeader className="px-4 pt-4">
          <CardTitle className="text-[16px] leading-tight group-hover:text-blue-700">
            {example.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3 px-4 pb-4">
          <p className="line-clamp-2 text-copy-14 text-gray-900">{example.description}</p>
          {example.tags.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5" aria-label="Tags">
              {example.tags.slice(0, MAX_VISIBLE_TAGS).map((tag) => (
                <li key={tag}>
                  <Badge variant="secondary">{tag}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </CardContent>
      </Card>
    </Link>
  );
}
