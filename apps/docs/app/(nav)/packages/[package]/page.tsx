import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  getPackageGroup,
  packageGroups,
  recordHref,
  titleForRecord,
} from '@/lib/manifest';

interface PackagePageProps {
  params: { package: string };
}

export function generateStaticParams() {
  return packageGroups
    .filter((group) => group.packageName !== 'guides')
    .map((group) => ({ package: group.packageSlug }));
}

export function generateMetadata({ params }: PackagePageProps) {
  const group = getPackageGroup(params.package);
  if (!group || group.packageName === 'guides') return {};
  return {
    title: `${group.title} reference`,
    description: group.description,
  };
}

export default function PackagePage({ params }: PackagePageProps) {
  const group = getPackageGroup(params.package);
  if (!group || group.packageName === 'guides') notFound();

  return (
    <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-5xl mx-auto">
      <header className="mb-10">
        <Link href="/packages" className="text-sm text-gray-9 hover:text-blue-9 transition-colors">
          ← Packages
        </Link>
        <h1 className="mt-4 text-3xl md:text-4xl font-semibold text-gray-12">{group.title}</h1>
        <p className="mt-4 max-w-3xl text-xl text-gray-10">{group.description}</p>
      </header>

      <div className="rounded-lg border border-gray-4 bg-gray-1 overflow-hidden">
        <div className="border-b border-gray-4 bg-gray-2 px-4 py-3 text-xs font-medium uppercase tracking-wider text-gray-9">
          {group.records.length} documented symbols
        </div>
        <div className="divide-y divide-gray-4">
          {group.records.map((record) => (
            <Link
              key={record.symbol}
              href={recordHref(record)}
              className="group block px-4 py-4 transition-colors hover:bg-gray-2/60"
            >
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h2 className="font-mono text-sm font-semibold text-gray-12 group-hover:text-blue-9 transition-colors">
                    {record.symbol}
                  </h2>
                  <p className="mt-1 text-sm text-gray-9">{titleForRecord(record)}</p>
                </div>
                <span className="text-gray-9 group-hover:text-blue-9 transition-colors">→</span>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
