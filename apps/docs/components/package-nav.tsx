'use client';

import Link from 'next/link';
import type { NavGroup } from '@/lib/nav';

interface PackageNavProps {
  groups: NavGroup[];
  pathname: string;
  onNavigate?: () => void;
}

interface NavGroupListProps {
  group: NavGroup;
  pathname: string;
  onNavigate?: () => void;
  depth: number;
}

export function PackageNav({ groups, pathname, onNavigate }: PackageNavProps) {
  return (
    <div className="space-y-3">
      {groups.map((group) => (
        <NavGroupList key={group.title} group={group} pathname={pathname} onNavigate={onNavigate} depth={0} />
      ))}
    </div>
  );
}

function NavGroupList({ group, pathname, onNavigate, depth }: NavGroupListProps) {
  return (
    <div>
      {group.title ? (
        <div className={`px-3 ${depth === 0 ? 'mb-1' : 'mb-0.5'} text-[11px] font-medium uppercase tracking-wider text-gray-8`}>
          {group.title}
          {group.badge ? <span className="ml-2 text-[10px] text-yellow-10">{group.badge}</span> : null}
        </div>
      ) : null}
      {group.items?.length ? (
        <ul className="space-y-0.5">
          {group.items.map((item) => {
            const isActive = pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  onClick={onNavigate}
                  className={`block truncate rounded-md py-1.5 pr-3 text-sm transition-colors ${depth > 0 ? 'pl-6' : 'pl-3'} ${
                    isActive
                      ? 'bg-gray-2 text-gray-12 font-medium'
                      : 'text-gray-10 hover:bg-gray-1 hover:text-gray-12'
                  }`}
                  title={item.title}
                >
                  {item.title}
                  {item.badge ? <span className="ml-2 text-[10px] uppercase text-yellow-10">{item.badge}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
      {group.groups?.length ? (
        <div className="mt-2 space-y-2">
          {group.groups.map((child) => (
            <NavGroupList key={child.title} group={child} pathname={pathname} onNavigate={onNavigate} depth={depth + 1} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
