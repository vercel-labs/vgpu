import { translations } from "../../../../../geistdocs";
import { buildExampleV0RegistryItem } from "../../../../../lib/example-actions";
import { examples, getExample } from "../../../../../lib/examples-registry";

interface ExampleV0RouteContext {
  params: Promise<{ lang: string; slug: string }>;
}

export const revalidate = false;

export function generateStaticParams() {
  return Object.keys(translations).flatMap((lang) =>
    examples.map((example) => ({ lang, slug: example.meta.slug })),
  );
}

export async function GET(
  _request: Request,
  { params }: ExampleV0RouteContext,
): Promise<Response> {
  const { slug } = await params;
  const example = getExample(slug);

  if (!example) {
    return Response.json({ error: "Example not found" }, { status: 404 });
  }

  return Response.json(buildExampleV0RegistryItem(example), {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
