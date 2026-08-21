import Link from "next/link";

const recoveryLinks = [
  ["Read the docs", "/docs"],
  ["Browse examples", "/examples"],
  ["Search the docs", "/docs?search="],
  ["Markdown sitemap", "/sitemap.md"],
  ["Complete Markdown export", "/llms.txt"],
] as const;

export default function NotFoundPage() {
  return (
    <main className="mx-auto flex min-h-[60vh] max-w-3xl flex-col justify-center px-6 py-20">
      <p className="text-label-14 font-medium text-gray-900">404 · vgpu</p>
      <h1 className="mt-3 text-heading-40 font-medium tracking-tighter text-gray-1000">Page not found</h1>
      <p className="mt-4 max-w-xl text-copy-16 leading-7 text-gray-900">
        This URL does not point to a vgpu page. Use one of the project indexes below to recover.
      </p>
      <ul className="mt-8 grid gap-3 sm:grid-cols-2">
        {recoveryLinks.map(([label, href]) => (
          <li key={href}>
            <Link className="block rounded-md border border-gray-400 px-4 py-3 hover:bg-gray-100" href={href}>
              {label}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
