import { posix } from 'node:path';
import { integrity } from './errors.js';
export function assertSafeRelativePath(value) {
  let decoded;
  try { decoded = decodeURIComponent(value); } catch { throw integrity(`Invalid encoded path: ${value}`); }
  if (!value || decoded !== value || value !== posix.normalize(value) || value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes('%') || /^[A-Za-z]:/.test(value) || /[\0-\x1f\x7f]/.test(value) || value.split('/').some((p) => !p || p === '.' || p === '..')) throw integrity(`Unsafe source path: ${value}`);
  return value;
}
export function assertUniquePaths(files) {
 const exact = new Set(), folded = new Set();
 for (const file of files) { const p=assertSafeRelativePath(file.path); const f=p.normalize('NFC').toLocaleLowerCase('en-US'); if(exact.has(p)||folded.has(f)) throw integrity(`Colliding source path: ${p}`); exact.add(p); folded.add(f); }
}
