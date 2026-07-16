import Link from 'next/link';
import type { NavItem } from '@/lib/nav';

interface PageNavigationProps {
  prev: NavItem | null;
  next: NavItem | null;
}

export function PageNavigation({ prev, next }: PageNavigationProps) {
  if (!prev && !next) return null;

  return (
    <nav aria-label="Previous and next pages" className="mt-14 grid gap-4 border-t border-gray-4 pt-6 md:grid-cols-2">
      {prev ? (
        <Link href={prev.href} className="group rounded-lg border border-gray-4 bg-gray-1 p-4 transition-colors hover:border-gray-5 hover:bg-gray-2/50">
          <div className="text-xs uppercase tracking-wide text-gray-8">Previous</div>
          <div className="mt-2 font-medium text-gray-12 group-hover:text-blue-9">← {prev.title}</div>
        </Link>
      ) : <div />}
      {next ? (
        <Link href={next.href} className="group rounded-lg border border-gray-4 bg-gray-1 p-4 text-right transition-colors hover:border-gray-5 hover:bg-gray-2/50">
          <div className="text-xs uppercase tracking-wide text-gray-8">Next</div>
          <div className="mt-2 font-medium text-gray-12 group-hover:text-blue-9">{next.title} →</div>
        </Link>
      ) : null}
    </nav>
  );
}
