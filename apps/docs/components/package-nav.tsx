'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navSections, packageHref, recordHref } from '@/lib/manifest';

export function PackageNav() {
  const pathname = usePathname();

  return (
    <div className="mt-4 space-y-5">
      {navSections.map((section) => (
        <div key={section.title}>
          <h5 className="px-3 mb-2 text-[11px] font-medium text-gray-8 uppercase tracking-wider">
            {section.title}
          </h5>
          <div className="space-y-3">
            {section.groups.map((group) => {
              const packageActive = pathname === packageHref(group.packageName);
              return (
                <div key={group.packageName}>
                  <Link
                    href={packageHref(group.packageName)}
                    className={`block px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      packageActive
                        ? 'bg-gray-2 text-gray-12'
                        : 'text-gray-9 hover:bg-gray-1 hover:text-gray-12'
                    }`}
                  >
                    {group.title}
                  </Link>
                  <ul className="mt-1 space-y-0.5">
                    {group.records.map((record) => {
                      const href = recordHref(record);
                      const isActive = pathname === href;
                      return (
                        <li key={`${record.package}:${record.symbol}`}>
                          <Link
                            href={href}
                            className={`block truncate rounded-md py-1 pl-5 pr-3 text-xs transition-colors ${
                              isActive
                                ? 'bg-gray-2 text-blue-10'
                                : 'text-gray-8 hover:bg-gray-1 hover:text-gray-11'
                            }`}
                            title={record.symbol}
                          >
                            {record.symbol}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
