import { constants } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';

const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FD_ROOT = process.platform === 'linux' ? '/proc/self/fd' : process.platform === 'darwin' ? '/dev/fd' : undefined;

/**
 * Runs an operation relative to an opened parent-directory descriptor. Keeping
 * the descriptor open prevents a checked parent from being swapped for a
 * symlink before the file operation (the usual realpath/check-use race).
 */
export function withSafeLocalParent<T>(
  rootDirectory: string,
  key: string,
  createParents: true,
  operation: (anchoredDestination: string) => Promise<T>,
): Promise<T>;
export function withSafeLocalParent<T>(
  rootDirectory: string,
  key: string,
  createParents: false,
  operation: (anchoredDestination: string) => Promise<T>,
): Promise<T | undefined>;
export async function withSafeLocalParent<T>(
  rootDirectory: string,
  key: string,
  createParents: boolean,
  operation: (anchoredDestination: string) => Promise<T>,
): Promise<T | undefined> {
  const fdRoot = FD_ROOT;
  if (!fdRoot) throw new Error(`Safe local artifact storage is unsupported on ${process.platform}`);
  const parts = validateKey(key);
  const configuredRoot = resolve(rootDirectory);
  if (createParents) await mkdir(configuredRoot, { recursive: true, mode: 0o700 });

  let directory;
  try {
    directory = await open(configuredRoot, DIRECTORY_FLAGS);
  } catch (error) {
    if (!createParents && isNotFound(error)) return undefined;
    if (isUnsafeLink(error)) throw new Error(`Unsafe symbolic link in local artifact root: ${configuredRoot}`);
    throw error;
  }

  try {
    for (const part of parts.slice(0, -1)) {
      const child = `${fdRoot}/${directory.fd}/${part}`;
      let next;
      try {
        next = await open(child, DIRECTORY_FLAGS);
      } catch (error) {
        if (isNotFound(error) && createParents) {
          try {
            await mkdir(child, { mode: 0o700 });
          } catch (mkdirError) {
            if (!isAlreadyExists(mkdirError)) throw mkdirError;
          }
          try {
            next = await open(child, DIRECTORY_FLAGS);
          } catch (openError) {
            if (isUnsafeLink(openError)) throw new Error(`Unsafe symbolic link in artifact path: ${key}`);
            throw openError;
          }
        } else if (isNotFound(error) && !createParents) {
          return undefined;
        } else if (isUnsafeLink(error)) {
          throw new Error(`Unsafe symbolic link in artifact path: ${key}`);
        } else {
          throw error;
        }
      }
      await directory.close();
      directory = next;
    }
    return await operation(`${fdRoot}/${directory.fd}/${parts[parts.length - 1]}`);
  } finally {
    await directory.close();
  }
}

interface BoundedReadableFile {
  stat(): Promise<{ readonly size: number; isFile(): boolean }>;
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ readonly bytesRead: number }>;
}

/** Reads the fstat size plus one byte at most, so in-place growth cannot bypass a response cap. */
export async function readBoundedLocalFile(
  handle: BoundedReadableFile,
  maximumBytes: number,
  key: string,
): Promise<Uint8Array | undefined> {
  const stat = await handle.stat();
  if (!stat.isFile()) return undefined;
  if (stat.size > maximumBytes) throw new Error(`Stored artifact exceeds response limit: ${key}`);

  const bytes = new Uint8Array(stat.size);
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
    if (bytesRead === 0) return bytes.subarray(0, offset);
    offset += bytesRead;
  }

  const growthProbe = new Uint8Array(1);
  const { bytesRead } = await handle.read(growthProbe, 0, 1, offset);
  if (bytesRead !== 0) throw new Error(`Stored artifact exceeds response limit: ${key}`);
  return bytes;
}

export async function readSafeLocalFile(
  rootDirectory: string,
  key: string,
  maximumBytes = Number.MAX_SAFE_INTEGER,
): Promise<Uint8Array | undefined> {
  return withSafeLocalParent(rootDirectory, key, false, async (destination) => {
    let handle;
    try {
      const beforeOpen = await lstat(destination);
      if (beforeOpen.isSymbolicLink() || !beforeOpen.isFile()) return undefined;
      if (beforeOpen.size > maximumBytes) throw new Error(`Stored artifact exceeds response limit: ${key}`);
      handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
      return await readBoundedLocalFile(handle, maximumBytes, key);
    } catch (error) {
      if (isNotFound(error) || isUnsafeLink(error)) return undefined;
      throw error;
    } finally {
      await handle?.close();
    }
  });
}

export async function assertSafeMutableLeaf(destination: string): Promise<void> {
  try {
    const stat = await lstat(destination);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`Unsafe mutable artifact leaf: ${destination}`);
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }
}

function validateKey(key: string): string[] {
  const parts = key.split('/');
  if (!key || key.startsWith('/') || key.includes('\\') || key.includes('\0') ||
      parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Invalid artifact key: ${key}`);
  }
  return parts;
}

function isNotFound(error: unknown): boolean {
  return hasCode(error, 'ENOENT');
}

function isAlreadyExists(error: unknown): boolean {
  return hasCode(error, 'EEXIST');
}

function isUnsafeLink(error: unknown): boolean {
  return hasCode(error, 'ELOOP') || hasCode(error, 'ENOTDIR');
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error &&
    (error as NodeJS.ErrnoException).code === code;
}
