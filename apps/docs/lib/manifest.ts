import { docsManifest } from 'vgpu/lib/generated/docs-manifest.generated.js';

export type DocsRecordKind = 'api' | 'guide';

export interface DocsRecord {
  package: string;
  symbol: string;
  repoPath: string;
  kind: DocsRecordKind;
  virtualPath: string;
  content: string;
}

export interface PackageGroup {
  packageName: string;
  packageSlug: string;
  title: string;
  description: string;
  records: DocsRecord[];
}

export interface NavSection {
  title: string;
  groups: PackageGroup[];
}

const records = (docsManifest.records as DocsRecord[]).slice();

const packageOrder = [
  '@vgpu/core',
  '@vgpu/render',
  '@vgpu/render/passes',
  '@vgpu/render/inspect',
  '@vgpu/render/perf',
  '@vgpu/render/utils',
  '@vgpu/wgsl',
  '@vgpu/wgsl/runtime',
  '@vgpu/wgsl/loader-webpack',
  '@vgpu/wgsl/loader-vite',
  '@vgpu/wgsl-std',
  '@vgpu/adapter-node',
  '@vgpu/adapter-mock',
  'guides',
];

const sectionOrder = ['Core', 'Render', 'WGSL', 'Adapters', 'Guides', 'Other'];

const packageDescriptions: Record<string, string> = {
  '@vgpu/core': 'Device, resource, queue, shader, binding, and app primitives.',
  '@vgpu/render': 'Materials, meshes, render passes, render bundles, cameras, and uniform helpers.',
  '@vgpu/render/passes': 'Convenience pass helpers and canvas render targets.',
  '@vgpu/render/inspect': 'Debug materials and mesh inspection utilities.',
  '@vgpu/render/perf': 'GPU timing and pixel-diff measurement helpers.',
  '@vgpu/render/utils': 'Canvas sizing, frame clocks, and input utilities.',
  '@vgpu/wgsl': 'WGSL compile-time entry points and resolved shader metadata.',
  '@vgpu/wgsl/runtime': 'Runtime shader resolution primitives.',
  '@vgpu/wgsl/loader-webpack': 'Webpack loader entry point for WGSL modules.',
  '@vgpu/wgsl/loader-vite': 'Vite plugin and transform entry points for WGSL modules.',
  '@vgpu/wgsl-std': 'Standard WGSL modules and utility snippets.',
  '@vgpu/adapter-node': 'Dawn-backed adapter helpers for Node.js and serverless rendering.',
  '@vgpu/adapter-mock': 'Deterministic in-memory adapter for tests without GPU hardware.',
  guides: 'Conceptual and task-oriented articles for using vgpu effectively.',
};

export const docsRecords = records.sort(compareRecords);
export const apiRecords = docsRecords.filter((record) => record.kind === 'api');
export const guideRecords = docsRecords.filter((record) => record.kind === 'guide');

export function slugifyPackage(packageName: string) {
  if (packageName === 'guides') return 'guides';
  return packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
}

export function packageNameFromSlug(packageSlug: string) {
  return packageGroups.find((group) => group.packageSlug === packageSlug)?.packageName ?? null;
}

export function symbolToSlug(symbol: string) {
  return encodeURIComponent(symbol);
}

export function titleFromSlug(slug: string) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

export function titleForRecord(record: DocsRecord) {
  return firstMarkdownHeading(record.content) ?? record.symbol;
}

export function packageTitle(packageName: string) {
  if (packageName === 'guides') return 'Guides';
  return packageName;
}

export const packageGroups: PackageGroup[] = buildPackageGroups(docsRecords);

export const navSections: NavSection[] = buildNavSections(packageGroups);

export function getPackageGroup(packageSlug: string) {
  return packageGroups.find((group) => group.packageSlug === packageSlug) ?? null;
}

export function getRecord(packageSlug: string, symbol: string) {
  const decodedSymbol = decodeURIComponent(symbol);
  const packageName = packageNameFromSlug(packageSlug);
  if (!packageName) return null;
  return docsRecords.find((record) => record.package === packageName && record.symbol === decodedSymbol) ?? null;
}

export function getGuideRecord(guideSlug: string) {
  const decodedSlug = decodeURIComponent(guideSlug);
  return guideRecords.find((record) => record.symbol === decodedSlug) ?? null;
}

export function recordHref(record: DocsRecord) {
  if (record.kind === 'guide') return `/guides/${symbolToSlug(record.symbol)}`;
  return `/packages/${slugifyPackage(record.package)}/${symbolToSlug(record.symbol)}`;
}

export function packageHref(packageName: string) {
  if (packageName === 'guides') return '/guides';
  return `/packages/${slugifyPackage(packageName)}`;
}

export function sourceHref(record: DocsRecord) {
  return `https://github.com/vercel-labs/vgpu/blob/main/${record.repoPath}`;
}

export function resolveMarkdownHref(href: string | undefined) {
  if (!href) return href;
  if (/^(https?:|mailto:|#)/.test(href)) return href;

  const docsMdMatch = href.match(/(?:^|\/)\.?(?:\/)?([^/]+)\.docs\.md(?:#(.*))?$/);
  if (docsMdMatch) {
    const [, slug, hash] = docsMdMatch;
    const guide = getGuideRecord(slug);
    if (guide) return `${recordHref(guide)}${hash ? `#${hash}` : ''}`;

    const record = docsRecords.find((item) => item.symbol === slug || item.virtualPath.endsWith(`/${slug}.docs.md`));
    if (record) return `${recordHref(record)}${hash ? `#${hash}` : ''}`;
  }

  return href;
}

function buildPackageGroups(sourceRecords: DocsRecord[]) {
  const byPackage = new Map<string, DocsRecord[]>();
  for (const record of sourceRecords) {
    const current = byPackage.get(record.package) ?? [];
    current.push(record);
    byPackage.set(record.package, current);
  }

  return Array.from(byPackage.entries())
    .map(([packageName, packageRecords]) => ({
      packageName,
      packageSlug: slugifyPackage(packageName),
      title: packageTitle(packageName),
      description: packageDescriptions[packageName] ?? `Reference documentation for ${packageName}.`,
      records: packageRecords.sort(compareRecords),
    }))
    .sort((a, b) => comparePackageNames(a.packageName, b.packageName));
}

function buildNavSections(groups: PackageGroup[]) {
  const sections = new Map<string, PackageGroup[]>();
  for (const group of groups) {
    const section = sectionForPackage(group.packageName);
    sections.set(section, [...(sections.get(section) ?? []), group]);
  }

  return Array.from(sections.entries())
    .map(([title, sectionGroups]) => ({
      title,
      groups: sectionGroups.sort((a, b) => comparePackageNames(a.packageName, b.packageName)),
    }))
    .sort((a, b) => sectionOrder.indexOf(a.title) - sectionOrder.indexOf(b.title));
}

function compareRecords(a: DocsRecord, b: DocsRecord) {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  if (a.package !== b.package) return comparePackageNames(a.package, b.package);
  return a.symbol.localeCompare(b.symbol);
}

function comparePackageNames(a: string, b: string) {
  const aIndex = packageOrder.indexOf(a);
  const bIndex = packageOrder.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }
  return a.localeCompare(b);
}

function sectionForPackage(packageName: string) {
  if (packageName === 'guides') return 'Guides';
  if (packageName.startsWith('@vgpu/render')) return 'Render';
  if (packageName.startsWith('@vgpu/wgsl')) return 'WGSL';
  if (packageName.startsWith('@vgpu/adapter')) return 'Adapters';
  if (packageName === '@vgpu/core') return 'Core';
  return 'Other';
}

function firstMarkdownHeading(markdown: string) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}
