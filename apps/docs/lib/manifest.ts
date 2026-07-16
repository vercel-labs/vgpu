import { docsManifest } from '@vgpu/cli/lib/generated/docs-manifest.generated.js';

export type DocsRecordKind = 'api' | 'guide';
export type DocsSymbolKind = 'class' | 'function' | 'type' | 'options';

export interface DocsRecord {
  package: string;
  symbol: string;
  repoPath: string;
  kind: DocsRecordKind;
  virtualPath: string;
  content: string;
  summary: string;
  snippet: string;
  anchor: string;
  topic: string;
  topicTitle: string;
  symbolKind: DocsSymbolKind;
}

export interface ReferenceTopic {
  packageName: string;
  packageSlug: string;
  title: string;
  description: string;
  topic: string;
  topicTitle: string;
  href: string;
  repoPath: string;
  records: DocsRecord[];
  content: string;
  advanced: boolean;
}

export interface ReferenceGroup {
  packageName: string;
  packageSlug: string;
  title: string;
  description: string;
  advanced: boolean;
  topics: ReferenceTopic[];
  records: DocsRecord[];
}

export interface NavSection {
  title: string;
  groups: ReferenceGroup[];
}

const packageOrder = [
  'vgpu',
  'vgpu/scene',
  '@vgpu/wgsl',
  '@vgpu/wgsl-std',
  'vgpu/core',
  '@vgpu/render',
];

const topicOrder: Record<string, string[]> = {
  vgpu: ['init', 'gpu', 'surface', 'target', 'frame', 'pass', 'draw', 'compute', 'uniforms', 'bundle'],
  'vgpu/scene': ['mesh', 'camera', 'orthographic-camera', 'perspective-camera', 'deg-to-rad', 'srgb', 'orbit'],
  'vgpu/core': ['device', 'buffer', 'texture', 'queue', 'vgpu-error', 'vgpu-adapter', 'bind', 'render-bundle', 'storage-buffer', 'uniform', 'structured-uniform', 'uniform-pool'],
  '@vgpu/wgsl': ['compile', 'resolved-shader', 'runtime', 'loader-webpack', 'loader-vite'],
  '@vgpu/wgsl-std': ['color', 'fullscreen', 'hash', 'noise'],
  '@vgpu/render': ['wireframe-material', 'normal-debug-material', 'mesh-to-readable', 'mesh-to-wireframe', 'inspect-material', 'canvas-mouse-tracker', 'frame-clock', 'canvas-resolution', 'perf', 'edit'],
};

const packageDescriptions: Record<string, string> = {
  vgpu: 'Public API: init, Gpu, pass, draw, compute, frame, bundle, target, ping-pong, and uniforms.',
  'vgpu/scene': 'Tree-shakeable geometry, camera, color, and orbit helpers without a retained scene graph.',
  'vgpu/core': 'Advanced escape hatches for native WebGPU handles, buffers, textures, bind groups, and structured uniforms.',
  '@vgpu/wgsl': 'WGSL compile-time entry points, runtime resolution, reflection metadata, and bundler loaders.',
  '@vgpu/wgsl-std': 'Standard WGSL modules for color, fullscreen triangles, hashes, and procedural noise.',
  '@vgpu/render': 'Advanced render tooling for inspection, performance measurement, utilities, and mesh editing.',
  guides: 'Conceptual and task-oriented articles for using vgpu effectively.',
};

const packageTitles: Record<string, string> = {
  vgpu: 'vgpu',
  'vgpu/scene': 'vgpu/scene',
  'vgpu/core': 'vgpu/core',
  '@vgpu/wgsl': '@vgpu/wgsl',
  '@vgpu/wgsl-std': '@vgpu/wgsl-std',
  '@vgpu/render': '@vgpu/render',
};

export const docsRecords = (docsManifest.records as DocsRecord[]).slice().sort(compareRecords);
export const apiRecords = docsRecords.filter((record) => record.kind === 'api');
export const guideRecords = docsRecords.filter((record) => record.kind === 'guide');
export const referenceGroups = buildReferenceGroups(apiRecords);
export const referenceTopics = referenceGroups.flatMap((group) => group.topics);
export const packageGroups = referenceGroups;
export const navSections: NavSection[] = buildNavSections(referenceGroups);

export function referencePackageName(record: DocsRecord) {
  if (record.package === 'vgpu' || record.package === 'vgpu/core' || record.package === 'vgpu/scene') return record.package;
  if (record.package.startsWith('@vgpu/wgsl-std')) return '@vgpu/wgsl-std';
  if (record.package.startsWith('@vgpu/wgsl')) return '@vgpu/wgsl';
  if (record.package.startsWith('@vgpu/render')) return '@vgpu/render';
  return record.package;
}

export function slugifyPackage(packageName: string) {
  if (packageName === 'guides') return 'guides';
  if (packageName === '@vgpu/wgsl') return 'wgsl';
  if (packageName === '@vgpu/wgsl-std') return 'wgsl-std';
  if (packageName === '@vgpu/render') return 'render';
  return packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
}

export function legacyPackageSlug(packageName: string) {
  return packageName.replace(/^@/, '').replace(/[\/@]/g, '-');
}

export function packageNameFromSlug(packageSlug: string) {
  return referenceGroups.find((group) => group.packageSlug === packageSlug)?.packageName ?? null;
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
  return record.topicTitle || firstMarkdownHeading(record.content) || record.symbol;
}

export function packageTitle(packageName: string) {
  return packageTitles[packageName] ?? packageName;
}

export function packageHref(packageName: string) {
  if (packageName === 'guides') return '/guides';
  return `/reference#${slugifyPackage(packageName)}`;
}

export function topicHref(topic: Pick<ReferenceTopic, 'packageSlug' | 'topic'>) {
  return `/reference/${topic.packageSlug}/${encodeURIComponent(topic.topic)}`;
}

export function recordHref(record: DocsRecord) {
  if (record.kind === 'guide') return `/guides/${symbolToSlug(record.symbol)}`;
  return `${topicHrefForRecord(record)}#${record.anchor}`;
}

export function topicHrefForRecord(record: DocsRecord) {
  const packageName = referencePackageName(record);
  return `/reference/${slugifyPackage(packageName)}/${encodeURIComponent(record.topic)}`;
}

export function getReferenceGroup(packageSlug: string) {
  return referenceGroups.find((group) => group.packageSlug === packageSlug) ?? null;
}

export function getReferenceTopic(packageSlug: string, topicSlug: string) {
  const decodedTopic = decodeURIComponent(topicSlug);
  return referenceTopics.find((topic) => topic.packageSlug === packageSlug && topic.topic === decodedTopic) ?? null;
}

export function getRecord(packageSlug: string, symbol: string) {
  const decodedSymbol = decodeURIComponent(symbol);
  const packageName = packageNameFromSlug(packageSlug);
  if (!packageName) return null;
  return apiRecords.find((record) => referencePackageName(record) === packageName && record.symbol === decodedSymbol) ?? null;
}

export function getGuideRecord(guideSlug: string) {
  const decodedSlug = decodeURIComponent(guideSlug);
  return guideRecords.find((record) => record.symbol === decodedSlug) ?? null;
}

export function sourceHref(record: DocsRecord | ReferenceTopic) {
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

const recordsBySymbol = buildRecordsBySymbol(apiRecords);

export function resolveSymbolHref(symbol: string) {
  const matches = recordsBySymbol.get(symbol);
  if (!matches?.length) return null;
  if (matches.length === 1) return recordHref(matches[0]);

  const publicApiMatch = matches.find((record) => referencePackageName(record) === 'vgpu');
  if (publicApiMatch) return recordHref(publicApiMatch);

  return null;
}

function buildRecordsBySymbol(records: DocsRecord[]) {
  const bySymbol = new Map<string, DocsRecord[]>();
  for (const record of records) {
    bySymbol.set(record.symbol, [...(bySymbol.get(record.symbol) ?? []), record]);
  }
  return bySymbol;
}

function buildReferenceGroups(sourceRecords: DocsRecord[]) {
  const byPackage = new Map<string, DocsRecord[]>();
  for (const record of sourceRecords) {
    const packageName = referencePackageName(record);
    byPackage.set(packageName, [...(byPackage.get(packageName) ?? []), record]);
  }

  return Array.from(byPackage.entries())
    .map(([packageName, packageRecords]) => {
      const packageSlug = slugifyPackage(packageName);
      const records = packageRecords.sort(compareRecords);
      const advanced = packageName === 'vgpu/core' || packageName === '@vgpu/render';
      return {
        packageName,
        packageSlug,
        title: packageTitle(packageName),
        description: packageDescriptions[packageName] ?? `Reference documentation for ${packageName}.`,
        advanced,
        records,
        topics: buildReferenceTopics(packageName, packageSlug, records, advanced),
      };
    })
    .sort((a, b) => comparePackageNames(a.packageName, b.packageName));
}

function buildReferenceTopics(packageName: string, packageSlug: string, records: DocsRecord[], advanced: boolean) {
  const byTopic = new Map<string, DocsRecord[]>();
  for (const record of records) {
    byTopic.set(record.topic, [...(byTopic.get(record.topic) ?? []), record]);
  }

  return Array.from(byTopic.entries())
    .map(([topic, topicRecords]) => {
      const sortedRecords = topicRecords.sort(compareTopicRecords);
      const first = sortedRecords[0];
      return {
        packageName,
        packageSlug,
        title: packageTitle(packageName),
        description: packageDescriptions[packageName] ?? `Reference documentation for ${packageName}.`,
        topic,
        topicTitle: first.topicTitle || titleFromSlug(topic),
        href: `/reference/${packageSlug}/${encodeURIComponent(topic)}`,
        repoPath: first.repoPath,
        records: sortedRecords,
        content: first.content,
        advanced,
      };
    })
    .sort((a, b) => compareTopics(packageName, a.topic, b.topic));
}

function buildNavSections(groups: ReferenceGroup[]) {
  const primary = groups.filter((group) => !group.advanced);
  const advanced = groups.filter((group) => group.advanced);
  return [
    { title: 'API Reference', groups: primary },
    { title: 'Advanced', groups: advanced },
  ].filter((section) => section.groups.length > 0);
}

function compareRecords(a: DocsRecord, b: DocsRecord) {
  if (a.kind !== b.kind) return a.kind.localeCompare(b.kind);
  if (a.package !== b.package) return comparePackageNames(referencePackageName(a), referencePackageName(b));
  if (a.topic !== b.topic) return compareTopics(referencePackageName(a), a.topic, b.topic);
  return a.symbol.localeCompare(b.symbol);
}

function compareTopicRecords(a: DocsRecord, b: DocsRecord) {
  if (a.repoPath === b.repoPath) return a.symbol.localeCompare(b.symbol);
  return a.repoPath.localeCompare(b.repoPath);
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

function compareTopics(packageName: string, a: string, b: string) {
  const order = topicOrder[packageName] ?? [];
  const aIndex = order.indexOf(a);
  const bIndex = order.indexOf(b);
  if (aIndex !== -1 || bIndex !== -1) {
    if (aIndex === -1) return 1;
    if (bIndex === -1) return -1;
    return aIndex - bIndex;
  }
  return a.localeCompare(b);
}

function firstMarkdownHeading(markdown: string) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}
