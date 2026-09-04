import { translations } from "../../../../../geistdocs";
import { portableExampleSource } from "../../../../../lib/example-export";
import { examples, getExample } from "../../../../../lib/examples-registry";
import { createZip } from "../../../../../lib/zip";

interface ExampleDownloadRouteContext {
  params: Promise<{ lang: string; slug: string }>;
}

export const revalidate = false;
export const runtime = "nodejs";

export function generateStaticParams() {
  return Object.keys(translations).flatMap((lang) =>
    examples.map((example) => ({ lang, slug: example.meta.slug })),
  );
}

export async function GET(
  _request: Request,
  { params }: ExampleDownloadRouteContext,
): Promise<Response> {
  const { slug } = await params;
  const example = getExample(slug);

  if (!example) {
    return Response.json({ error: "Example not found" }, { status: 404 });
  }

  const archive = createZip(
    example.sources.map(({ code, name }) => ({
      name: `${slug}/${name}`,
      content: portableExampleSource(code),
    })),
  );

  return new Response(archive, {
    headers: {
      "Cache-Control": "public, max-age=300, must-revalidate",
      "Content-Disposition": `attachment; filename="${slug}.zip"`,
      "Content-Length": archive.byteLength.toString(),
      "Content-Type": "application/zip",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
