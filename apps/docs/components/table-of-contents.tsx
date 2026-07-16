export interface TocItem {
  id: string;
  title: string;
  level: 2 | 3;
}

interface TableOfContentsProps {
  items: TocItem[];
}

export function TableOfContents({ items }: TableOfContentsProps) {
  if (items.length === 0) return null;
  return (
    <aside className="xl:sticky xl:top-8 xl:max-h-[calc(100vh-4rem)] xl:overflow-y-auto">
      <details className="rounded-lg border border-gray-4 bg-gray-1 p-4 xl:border-0 xl:bg-transparent xl:p-0" open>
        <summary className="cursor-pointer text-sm font-semibold text-gray-12 xl:cursor-default xl:list-none">
          On this page
        </summary>
        <ul className="mt-4 space-y-2 border-l border-gray-4 pl-4 text-sm">
          {items.map((item) => (
            <li key={item.id} className={item.level === 3 ? 'pl-4' : undefined}>
              <a href={`#${item.id}`} className="block text-gray-9 transition-colors hover:text-blue-9">
                {item.title}
              </a>
            </li>
          ))}
        </ul>
      </details>
    </aside>
  );
}
