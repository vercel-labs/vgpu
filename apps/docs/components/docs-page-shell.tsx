import { Breadcrumbs } from '@/components/breadcrumbs';
import { PageNavigation } from '@/components/page-navigation';
import { TableOfContents, type TocItem } from '@/components/table-of-contents';
import { getBreadcrumbs, getPrevNext } from '@/lib/nav';

interface DocsPageShellProps {
  pathname: string;
  toc?: TocItem[];
  children: React.ReactNode;
  className?: string;
  articleClassName?: string;
}

export function DocsPageShell({
  pathname,
  toc = [],
  children,
  className = '',
  articleClassName = 'min-w-0 max-w-4xl',
}: DocsPageShellProps) {
  const breadcrumbs = getBreadcrumbs(pathname);
  const { prev, next } = getPrevNext(pathname);
  const hasToc = toc.length > 0;

  return (
    <div className={`px-4 py-8 lg:px-8 lg:py-12 ${className}`}>
      <div className={`mx-auto grid max-w-7xl gap-10 ${hasToc ? 'xl:grid-cols-[minmax(0,1fr)_16rem]' : ''}`}>
        <article className={articleClassName}>
          <Breadcrumbs items={breadcrumbs} />
          {children}
          <PageNavigation prev={prev} next={next} />
        </article>
        {hasToc ? <TableOfContents items={toc} /> : null}
      </div>
    </div>
  );
}
