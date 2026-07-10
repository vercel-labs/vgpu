import Link from 'next/link';
import { packageGroups, packageHref } from '@/lib/manifest';

export default function PackagesPage() {
  return (
    <div className="px-4 py-8 lg:px-8 lg:py-12 max-w-5xl mx-auto">
      <header className="mb-10">
        <p className="text-sm font-medium text-blue-9 mb-3">Reference</p>
        <h1 className="text-3xl md:text-4xl font-semibold text-gray-12 mb-4">Packages</h1>
        <p className="text-xl text-gray-10 max-w-3xl">
          Generated reference documentation for every documented package, utility, adapter, and guide in vgpu.
        </p>
      </header>

      <div className="grid gap-4 md:grid-cols-2">
        {packageGroups.map((group) => (
          <Link
            key={group.packageName}
            href={packageHref(group.packageName)}
            className="group rounded-lg border border-gray-4 bg-gray-1 p-5 transition-all hover:border-gray-5 hover:bg-gray-2/50"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="font-semibold text-gray-12 group-hover:text-blue-9 transition-colors">
                  {group.title}
                </h2>
                <p className="mt-2 text-sm leading-6 text-gray-10">{group.description}</p>
              </div>
              <span className="text-gray-9 transition-transform group-hover:translate-x-0.5 group-hover:text-blue-9">→</span>
            </div>
            <div className="mt-4 text-xs text-gray-9">
              {group.records.length} {group.packageName === 'guides' ? 'guides' : 'symbols'}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
