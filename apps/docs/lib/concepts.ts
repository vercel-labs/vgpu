import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ConceptNavLink {
  title: string;
  href: string;
}

export interface ConceptFrontmatter {
  title: string;
  summary: string;
  relatedSymbols: string[];
  prevNext?: {
    prev?: ConceptNavLink;
    next?: ConceptNavLink;
  };
}

export interface ConceptHeading {
  id: string;
  text: string;
  level: 2 | 3;
}

export interface ConceptPage {
  slug: string;
  frontmatter: ConceptFrontmatter;
  content: string;
  headings: ConceptHeading[];
}

const conceptsDirectory = join(process.cwd(), 'content/concepts');

export function conceptSlugs() {
  return readdirSync(conceptsDirectory)
    .filter((file) => file.endsWith('.mdx'))
    .map((file) => file.replace(/\.mdx$/u, ''))
    .sort();
}

export function getConceptPage(slug: string): ConceptPage | null {
  if (!/^[a-z0-9-]+$/u.test(slug)) return null;

  try {
    const source = readFileSync(join(conceptsDirectory, `${slug}.mdx`), 'utf8');
    const { frontmatter, content } = parseConceptSource(source);
    return {
      slug,
      frontmatter,
      content,
      headings: extractHeadings(content),
    };
  } catch {
    return null;
  }
}

function parseConceptSource(source: string) {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u);
  if (!match) throw new Error('Concept MDX files must start with frontmatter.');

  return {
    frontmatter: parseFrontmatter(match[1]),
    content: match[2].trimStart(),
  };
}

function parseFrontmatter(raw: string): ConceptFrontmatter {
  const lines = raw.split(/\r?\n/u);
  const data: ConceptFrontmatter = { title: '', summary: '', relatedSymbols: [] };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;

    if (line.startsWith('title:')) {
      data.title = scalar(line);
      continue;
    }

    if (line.startsWith('summary:')) {
      data.summary = scalar(line);
      continue;
    }

    if (line.startsWith('relatedSymbols:')) {
      const symbols: string[] = [];
      while (lines[index + 1]?.startsWith('  - ')) {
        index += 1;
        symbols.push(lines[index].slice(4).trim());
      }
      data.relatedSymbols = symbols;
      continue;
    }

    if (line.startsWith('prevNext:')) {
      const prevNext: NonNullable<ConceptFrontmatter['prevNext']> = {};
      while (lines[index + 1]?.startsWith('  ')) {
        index += 1;
        const nested = lines[index];
        const key = nested.trim().replace(/:$/u, '') as 'prev' | 'next';
        if (key !== 'prev' && key !== 'next') continue;
        const link: Partial<ConceptNavLink> = {};
        while (lines[index + 1]?.startsWith('    ')) {
          index += 1;
          const child = lines[index].trim();
          if (child.startsWith('title:')) link.title = scalar(child);
          if (child.startsWith('href:')) link.href = scalar(child);
        }
        if (link.title && link.href) prevNext[key] = { title: link.title, href: link.href };
      }
      data.prevNext = prevNext;
    }
  }

  if (!data.title || !data.summary) throw new Error('Concept frontmatter requires title and summary.');
  return data;
}

function scalar(line: string) {
  return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/gu, '');
}

function extractHeadings(content: string): ConceptHeading[] {
  const counts = new Map<string, number>();
  const headings: ConceptHeading[] = [];

  for (const match of content.matchAll(/^(#{2,3})\s+(.+)$/gmu)) {
    const text = match[2].replace(/`([^`]+)`/gu, '$1').trim();
    const base = slugifyHeading(text);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    headings.push({
      id: count === 0 ? base : `${base}-${count + 1}`,
      text,
      level: match[1].length as 2 | 3,
    });
  }

  return headings;
}

function slugifyHeading(text: string) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/gu, '')
    .replace(/\s+/gu, '-')
    .replace(/-+/gu, '-');
}
