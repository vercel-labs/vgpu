'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { NavGroup, NavItem } from '@/lib/nav';

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
          {group.items.map((item) => (
            <NavItemEntry key={item.href} item={item} pathname={pathname} onNavigate={onNavigate} depth={depth} />
          ))}
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

interface NavItemEntryProps {
  item: NavItem;
  pathname: string;
  onNavigate?: () => void;
  depth: number;
}

function NavItemEntry({ item, pathname, onNavigate, depth }: NavItemEntryProps) {
  const hasChildren = Boolean(item.children?.length);
  const isInside = hasChildren
    && (pathname === item.href
      || item.children!.some((child) => pathname === child.href || pathname.startsWith(`${child.href}/`)));
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? isInside;

  const isActive = hasChildren
    ? pathname === item.href
    : pathname === item.href || (item.href !== '/' && pathname.startsWith(`${item.href}/`));

  const linkClassName = `block truncate rounded-md py-1.5 pr-3 text-sm transition-colors ${depth > 0 ? 'pl-6' : 'pl-3'} ${
    isActive
      ? 'bg-gray-2 text-gray-12 font-medium'
      : 'text-gray-10 hover:bg-gray-1 hover:text-gray-12'
  }`;

  return (
    <li>
      {hasChildren ? (
        <div className="flex items-center gap-0.5">
          <Link href={item.href} onClick={onNavigate} className={`min-w-0 flex-1 ${linkClassName}`} title={item.title}>
            {item.title}
            {item.badge ? <span className="ml-2 text-[10px] uppercase text-yellow-10">{item.badge}</span> : null}
          </Link>
          <button
            type="button"
            onClick={() => setManualOpen(!open)}
            aria-expanded={open}
            aria-label={`${open ? 'Collapse' : 'Expand'} ${item.title}`}
            className="mr-1 rounded p-1 text-gray-8 transition-colors hover:bg-gray-1 hover:text-gray-11"
          >
            <svg
              viewBox="0 0 12 12"
              className={`h-3 w-3 transition-transform ${open ? 'rotate-90' : ''}`}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M4.5 2.5 8 6l-3.5 3.5" />
            </svg>
          </button>
        </div>
      ) : (
        <Link href={item.href} onClick={onNavigate} className={linkClassName} title={item.title}>
          {item.title}
          {item.badge ? <span className="ml-2 text-[10px] uppercase text-yellow-10">{item.badge}</span> : null}
        </Link>
      )}
      {hasChildren && open ? (
        <ul className="mt-0.5 space-y-0.5">
          {item.children!.map((child) => {
            const childActive = pathname === child.href || (child.href !== '/' && pathname.startsWith(`${child.href}/`));
            return (
              <li key={child.href}>
                <Link
                  href={child.href}
                  onClick={onNavigate}
                  className={`block truncate rounded-md py-1.5 pr-3 text-sm transition-colors ${depth > 0 ? 'pl-9' : 'pl-6'} ${
                    childActive
                      ? 'bg-gray-2 text-gray-12 font-medium'
                      : 'text-gray-10 hover:bg-gray-1 hover:text-gray-12'
                  }`}
                  title={child.title}
                >
                  {child.title}
                  {child.badge ? <span className="ml-2 text-[10px] uppercase text-yellow-10">{child.badge}</span> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      ) : null}
    </li>
  );
}
