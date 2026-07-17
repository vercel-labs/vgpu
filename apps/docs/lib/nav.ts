import {
  getGuideRecord,
  getReferenceTopic,
  guideRecords,
  referenceGroups,
  referenceTopics,
  titleForRecord,
  topicHref,
  type ReferenceGroup,
  type ReferenceTopic,
} from '@/lib/manifest';

export type NavBadge = 'Advanced';

export interface NavItem {
  title: string;
  href: string;
  badge?: NavBadge;
  children?: NavItem[];
}

export interface NavGroup {
  title: string;
  items?: NavItem[];
  groups?: NavGroup[];
  badge?: NavBadge;
}

export interface NavSection {
  title: string;
  href?: string;
  groups: NavGroup[];
}

export interface FlatNavItem extends NavItem {
  section: string;
  groupPath: string[];
}

const guideGroups = [
  {
    title: 'General',
    slugs: ['getting-started'],
  },
  {
    title: 'Performance',
    slugs: [
      'performance-model',
      'performance-patterns',
      'authoring-for-perf',
      'measuring',
      'optimize-pass',
      'shader-fix-its',
      'performance-playbook',
    ],
  },
  {
    title: 'Testing',
    slugs: ['browser-testing'],
  },
] as const;


const exampleItems: NavItem[] = [
  { title: 'Simple Gradient', href: '/examples/gradient' },
  { title: 'Animated Wave', href: '/examples/wave' },
  { title: 'Color Cycle', href: '/examples/color-cycle' },
  { title: 'Raymarching', href: '/examples/raymarching' },
  { title: 'Procedural Noise', href: '/examples/noise' },
  { title: 'Metaballs', href: '/examples/metaballs' },
  { title: 'Fractal Explorer', href: '/examples/fractal' },
  { title: 'Alien Planet', href: '/examples/alien-planet' },
  { title: 'Fluid Simulation', href: '/examples/fluid' },
  { title: 'Triangle Particles', href: '/examples/triangle-particles' },
];

export const navSections: NavSection[] = [
  {
    title: 'Get started',
    href: '/get-started',
    groups: [
      {
        title: '',
        items: [
          { title: 'Agents', href: '/get-started/agents' },
          { title: 'Web', href: '/get-started/web' },
          { title: 'Node.js', href: '/get-started/node' },
        ],
      },
    ],
  },
  {
    title: 'Concepts',
    href: '/concepts',
    groups: [
      {
        title: '',
        items: [
          { title: 'Context', href: '/concepts/context' },
          { title: 'Draws', href: '/concepts/draws' },
          { title: 'Effects', href: '/concepts/effects' },
          { title: 'Passes', href: '/concepts/passes' },
          { title: 'Frames', href: '/concepts/frames' },
          { title: 'Render bundles', href: '/concepts/render-bundles' },
        ],
      },
    ],
  },
  {
    title: 'Guides',
    href: '/guides',
    groups: guideGroups.map((group) => ({
      title: group.title,
      items: group.slugs.flatMap((slug) => {
        const record = getGuideRecord(slug);
        return record ? [{ title: titleForRecord(record), href: `/guides/${record.symbol}` }] : [];
      }),
    })).filter((group) => group.items.length > 0),
  },
  {
    title: 'Examples',
    href: '/examples',
    groups: [
      {
        title: '',
        items: exampleItems,
      },
    ],
  },
  {
    title: 'API Reference',
    href: '/reference',
    groups: [...referenceGroups.map(referenceGroupToNavGroup)],
  },
  {
    title: 'Old drafts',
    groups: [
      {
        title: '',
        items: [
          { title: 'Introduction', href: '/' },
          { title: 'Installation & First Frame', href: '/getting-started' },
        ],
      },
    ],
  },
];

export const flatNavItems: FlatNavItem[] = flattenNavSections(navSections);

export function getPrevNext(pathname: string) {
  const normalized = normalizePathname(pathname);
  const index = flatNavItems.findIndex((item) => normalizePathname(item.href) === normalized);
  if (index === -1) return { prev: null, next: null };
  return {
    prev: index > 0 ? flatNavItems[index - 1] : null,
    next: index < flatNavItems.length - 1 ? flatNavItems[index + 1] : null,
  };
}

export function getNavItem(pathname: string) {
  const normalized = normalizePathname(pathname);
  return flatNavItems.find((item) => normalizePathname(item.href) === normalized) ?? null;
}

export function getBreadcrumbs(pathname: string): NavItem[] {
  const normalized = normalizePathname(pathname);
  if (normalized === '/') return [];

  const referenceMatch = normalized.match(/^\/reference\/([^/]+)\/([^/]+)$/);
  if (referenceMatch) {
    const topic = getReferenceTopic(referenceMatch[1], referenceMatch[2]);
    if (topic) {
      return [
        { title: 'Docs', href: '/' },
        { title: 'API Reference', href: '/reference' },
        { title: topic.title, href: `/reference#${topic.packageSlug}` },
        { title: topic.topicTitle, href: topicHref(topic) },
      ];
    }
  }

  const exampleMatch = normalized.match(/^\/examples\/([^/]+)$/);
  if (exampleMatch) {
    const exampleItem = exampleItems.find((item) => item.href === normalized);
    return [
      { title: 'Docs', href: '/' },
      { title: 'Examples', href: '/examples' },
      { title: exampleItem?.title ?? decodeURIComponent(exampleMatch[1]), href: normalized },
    ];
  }

  const navItem = getNavItem(normalized);
  if (navItem) {
    const crumbs: NavItem[] = [{ title: 'Docs', href: '/' }];
    if (navItem.section === 'Getting Started') return crumbs.concat(navItem);
    const sectionHref = sectionOverviewHref(navItem.section);
    crumbs.push({ title: navItem.section, href: sectionHref });
    for (const group of navItem.groupPath) {
      if (group && group !== navItem.section && group !== navItem.title && group !== 'Start here' && group !== 'Learn') {
        crumbs.push({ title: group, href: sectionHref });
      }
    }
    crumbs.push({ title: navItem.title, href: navItem.href });
    return dedupeBreadcrumbs(crumbs);
  }

  return [{ title: 'Docs', href: '/' }];
}

function referenceGroupToNavGroup(group: ReferenceGroup): NavGroup {
  return {
    title: group.title,
    badge: group.advanced ? 'Advanced' : undefined,
    items: group.topics.map(referenceTopicToNavItem),
  };
}

function referenceTopicToNavItem(topic: ReferenceTopic): NavItem {
  return {
    title: topic.topicTitle,
    href: topicHref(topic),
    badge: topic.advanced ? 'Advanced' : undefined,
  };
}

function flattenNavSections(sections: NavSection[]) {
  const items: FlatNavItem[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      flattenGroup(section.title, group, [group.title], items);
    }
  }
  return items;
}

function flattenGroup(section: string, group: NavGroup, groupPath: string[], items: FlatNavItem[]) {
  for (const item of group.items ?? []) {
    items.push({ ...item, section, groupPath });
    for (const child of item.children ?? []) {
      items.push({ ...child, section, groupPath: [...groupPath, item.title] });
    }
  }
  for (const child of group.groups ?? []) {
    flattenGroup(section, child, [...groupPath, child.title], items);
  }
}

function normalizePathname(pathname: string) {
  if (pathname.length > 1 && pathname.endsWith('/')) return pathname.slice(0, -1);
  return pathname;
}

function sectionOverviewHref(section: string) {
  if (section === 'Get started') return '/get-started';
  if (section === 'Getting Started') return '/getting-started';
  if (section === 'Concepts') return '/concepts';
  if (section === 'Core Concepts') return '/concepts';
  if (section === 'Guides') return '/guides';
  if (section === 'Examples') return '/examples';
  if (section === 'API Reference') return '/reference';
  return '/';
}

function dedupeBreadcrumbs(crumbs: NavItem[]) {
  return crumbs.filter((crumb, index) => index === 0 || crumb.href !== crumbs[index - 1]?.href || crumb.title !== crumbs[index - 1]?.title);
}

// Keep guideRecords referenced so this module fails loudly if guide generation is broken.
void guideRecords;
void referenceTopics;
