import { docsManifest } from '@vgpu/cli/lib/generated/docs-manifest.generated.js';

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

const publicApiRecords: DocsRecord[] = [
  doc(
    'init',
    '# init\n\nCreate the public ring-1 `Gpu` context. Browser code imports `init` from `vgpu`; headless code imports from `vgpu/node`; deterministic tests import from `vgpu/mock`.\n\n```ts\nimport { init } from "vgpu";\n\nconst gpu = await init(canvas, { dpr: [1, 2] });\n```',
  ),
  doc(
    'Gpu',
    '# Gpu\n\nThe context owns device lifetime and exposes the public factories: `pass`, `draw`, `compute`, `frame`, `bundle`, `target`, `uniforms`, `storage`, and ping-pong helpers. Prefer these factories before dropping to ring-0 handles.\n\n```ts\nconst target = gpu.target({ format: "rgba16float", depth: true, msaa: true });\nconst shared = gpu.uniforms({ time: 0, texel: target.texelSize });\n```',
  ),
  doc(
    'pass',
    '# pass\n\nFragment-only fullscreen sugar. `gpu.pass()` reflects WGSL bindings, owns values through `set()`, and draws to the screen or to an explicit target.\n\n```ts\nconst toneMap = gpu.pass(shader, { set: { exposure: 1 } });\ntoneMap.set({ time: gpu.time });\ntoneMap.draw({ target });\n```',
  ),
  doc(
    'draw',
    '# draw\n\nGeneral render pipeline entry point for vertex/fragment WGSL, meshes, target pre-warm, manual groups, dynamic offsets, and instancing.\n\n```ts\nconst draw = gpu.draw({ shader, mesh, targets: [target], instances: 128 });\ndraw.group(1, bindGroup);\ngpu.frame((f) => f.pass({ target }, (p) => p.draw(draw, { offsets: { 1: [offset] } })));\n```',
  ),
  doc(
    'compute',
    '# compute\n\nCreate reflected compute pipelines with explicit resources. Writable-storage aliasing is validated before dispatch.\n\n```ts\nconst state = gpu.pingPongStorage(bytes);\nconst step = gpu.compute(shader, { set: { src: state.read, dst: state.write } });\nstep.dispatch(workgroups);\nstate.swap();\n```',
  ),
  doc(
    'frame',
    '# frame\n\nSubmit on demand. Use a frame callback for multi-pass work and `frame.loop()` only when continuous animation is required.\n\n```ts\ngpu.frame((f) => {\n  f.pass({ target, clear: [0, 0, 0, 1] }, (p) => p.draw(draw));\n});\n```',
  ),
  doc(
    'bundle',
    '# bundle\n\nRecord static draw sequences once and replay them when the same work repeats across frames.\n\n```ts\nconst background = gpu.bundle({ target }, (b) => b.draw(grid));\ngpu.frame((f) => f.pass({ target }, (p) => p.bundles(background)));\n```',
  ),
  doc(
    'target',
    '# target\n\nTargets own size, texel size, color formats, optional depth, and MSAA. Resize targets instead of threading resolution globals through shaders.\n\n```ts\nconst hdr = gpu.target({ format: "rgba16float", depth: true, msaa: true });\npass.set({ texel: hdr.texelSize });\n```',
  ),
  doc(
    'uniforms',
    '# uniforms\n\nCreate shared uniform state once and bind the same object to multiple passes or draws. Update in place with `set()`.\n\n```ts\nconst globals = gpu.uniforms({ time: 0, viewProjection });\nsky.set({ globals });\nmesh.set({ globals });\nglobals.set({ time: gpu.time });\n```',
  ),
  doc(
    'pingPong',
    '# pingPong\n\nCreate two stable target or storage identities for iterative effects. Bind once, dispatch or draw, then swap read/write roles.\n\n```ts\nconst state = gpu.pingPongStorage(bytes);\nconst step = gpu.compute(shader, { set: { src: state.read, dst: state.write } });\nstep.dispatch(workgroups);\nstate.swap();\n```',
  ),
];

const generatedRecords = (docsManifest.records as DocsRecord[]).filter(isGeneratedRecordKept);
const records = [...publicApiRecords, ...generatedRecords];

const packageOrder = [
  'vgpu',
  '@vgpu/wgsl',
  '@vgpu/wgsl/runtime',
  '@vgpu/wgsl/loader-webpack',
  '@vgpu/wgsl/loader-vite',
  '@vgpu/wgsl-std',
  'guides',
];

const sectionOrder = ['VGPU', 'WGSL', 'Guides', 'Other'];

const packageDescriptions: Record<string, string> = {
  vgpu: 'Public ring-1 API: init, Gpu, pass, draw, compute, frame, bundle, target, ping-pong, and uniforms.',
  '@vgpu/wgsl': 'WGSL compile-time entry points and resolved shader metadata.',
  '@vgpu/wgsl/runtime': 'Runtime shader resolution primitives.',
  '@vgpu/wgsl/loader-webpack': 'Webpack loader entry point for WGSL modules.',
  '@vgpu/wgsl/loader-vite': 'Vite plugin and transform entry points for WGSL modules.',
  '@vgpu/wgsl-std': 'Standard WGSL modules and utility snippets.',
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

function doc(symbol: string, content: string): DocsRecord {
  return {
    package: 'vgpu',
    symbol,
    repoPath: `packages/vgpu-api/src/${symbol === 'pingPong' ? 'gpu' : symbol}.docs.md`,
    virtualPath: `/vgpu/${symbol}.docs.md`,
    kind: 'api',
    content,
  };
}

function isGeneratedRecordKept(record: DocsRecord) {
  return record.package === 'guides' || record.package.startsWith('@vgpu/wgsl');
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
  if (packageName === 'vgpu') return 'VGPU';
  if (packageName === 'guides') return 'Guides';
  if (packageName.startsWith('@vgpu/wgsl')) return 'WGSL';
  return 'Other';
}

function firstMarkdownHeading(markdown: string) {
  const match = markdown.match(/^#\s+(.+)$/m);
  return match?.[1]?.trim();
}
