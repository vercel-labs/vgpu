import Link from 'next/link';
import type { NavItem } from '@/lib/nav';

interface BreadcrumbsProps {
  items: NavItem[];
}

export function Breadcrumbs({ items }: BreadcrumbsProps) {
  if (items.length === 0) return null;

  return (
    <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-2 text-sm text-gray-9">
      {items.map((item, index) => {
        const isLast = index === items.length - 1;
        return (
          <span key={`${item.href}-${index}`} className="inline-flex items-center gap-2">
            {index > 0 ? <span aria-hidden="true">/</span> : null}
            {isLast ? (
              <span className="text-gray-11">{item.title}</span>
            ) : (
              <Link href={item.href} className="transition-colors hover:text-blue-9">
                {item.title}
              </Link>
            )}
          </span>
        );
      })}
    </nav>
  );
}
