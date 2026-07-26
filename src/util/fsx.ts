import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TimeloomError, isErrno } from '../errors.js';

/**
 * Repository-relative paths are stored POSIX-style regardless of host OS, so a store
 * created on Windows restores correctly on Linux and vice versa. Convert at the
 * boundary — never let a backslash path into a snapshot record.
 */
export function toRepoPath(osRelativePath: string): string {
  return osRelativePath.split(path.sep).join('/');
}

export function fromRepoPath(repoPath: string): string {
  return repoPath.split('/').join(path.sep);
}

/**
 * Resolve `repoPath` inside `root`, refusing anything that escapes.
 *
 * This is the single chokepoint protecting restore: a snapshot record is data, and
 * data from a store that someone else produced must never be able to write outside
 * the project directory. Rejects absolute paths, `..` traversal, NUL bytes, and —
 * because Windows treats them specially — reserved device names and trailing dots.
 */
export function resolveWithin(root: string, repoPath: string): string {
  if (repoPath.length === 0) {
    throw new TimeloomError('PATH_ESCAPE', 'Refusing to resolve an empty path');
  }
  if (repoPath.includes('\0')) {
    throw new TimeloomError('PATH_ESCAPE', `Path contains a NUL byte: ${JSON.stringify(repoPath)}`);
  }
  if (path.isAbsolute(repoPath) || /^[a-zA-Z]:/.test(repoPath)) {
    throw new TimeloomError('PATH_ESCAPE', `Refusing absolute path from snapshot: ${repoPath}`);
  }

  const segments = repoPath.split('/');
  for (const segment of segments) {
    if (segment === '..') {
      throw new TimeloomError('PATH_ESCAPE', `Refusing path traversal: ${repoPath}`);
    }
    if (WINDOWS_RESERVED.test(segment)) {
      throw new TimeloomError('PATH_ESCAPE', `Refusing reserved device name: ${repoPath}`);
    }
  }

  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, fromRepoPath(repoPath));
  const prefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  if (resolved !== absoluteRoot && !resolved.startsWith(prefix)) {
    throw new TimeloomError('PATH_ESCAPE', `Path escapes the project directory: ${repoPath}`);
  }
  return resolved;
}

// CON, PRN, AUX, NUL, COM1-9, LPT1-9 — with or without an extension — are device
// names on Windows. Writing to one does not create a file.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return false;
    throw error;
  }
}

/**
 * Write a file such that a reader never observes a partial version, and such that a
 * crash mid-write leaves either the old content or the new — never a truncated file.
 *
 * fsync before rename is the part people skip; without it a power loss can leave a
 * zero-length file with a valid directory entry on several filesystems.
 */
export async function atomicWriteFile(
  target: string,
  data: Buffer | string,
  tmpDir: string,
): Promise<void> {
  await ensureDir(tmpDir);
  await ensureDir(path.dirname(target));
  const tmpPath = path.join(tmpDir, `w-${randomUUID()}`);
  const handle = await fs.open(tmpPath, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmpPath, target);
  } catch (error) {
    await fs.rm(tmpPath, { force: true });
    throw error;
  }
  await syncDirectory(path.dirname(target));
}

/**
 * Best-effort directory fsync so the rename itself is durable. Windows cannot open a
 * directory for reading and several filesystems reject it; a failure here costs
 * durability on an already-rare crash window, not correctness, so it is swallowed.
 */
export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try {
    handle = await fs.open(dir, 'r');
    await handle.sync();
  } catch {
    return;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readJsonFile<T>(target: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await fs.readFile(target, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
  try {
    return JSON.parse(stripBom(raw)) as T;
  } catch (error) {
    throw new TimeloomError('CONFIG_INVALID', `${target} is not valid JSON`, {
      cause: error,
      hint: 'Delete the file to regenerate it, or fix the syntax by hand.',
    });
  }
}

export async function writeJsonFile(target: string, value: unknown, tmpDir: string): Promise<void> {
  await atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, tmpDir);
}

export async function removeIfExists(target: string): Promise<boolean> {
  try {
    await fs.rm(target, { force: false, recursive: false });
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/**
 * After deleting files during a restore, directories that became empty are removed
 * too — otherwise restoring away a whole feature leaves behind a skeleton of empty
 * folders. Walks upward from `startDir` and stops at `root` or the first non-empty
 * directory.
 */
export async function pruneEmptyDirsUpward(root: string, startDir: string): Promise<void> {
  const absoluteRoot = path.resolve(root);
  let current = path.resolve(startDir);
  while (current !== absoluteRoot && current.startsWith(absoluteRoot)) {
    let entries: string[];
    try {
      entries = await fs.readdir(current);
    } catch {
      return;
    }
    if (entries.length > 0) return;
    try {
      await fs.rmdir(current);
    } catch {
      return;
    }
    current = path.dirname(current);
  }
}

/**
 * Remove a UTF-8 byte order mark.
 *
 * `fs.readFile(path, 'utf8')` does not strip it, and `JSON.parse` rejects it
 * outright. Windows editors and PowerShell's `Set-Content -Encoding utf8` both emit
 * one by default, so a `package.json` carrying a BOM is a real thing that shows up
 * in real projects — and without this, reading it fails for no visible reason.
 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Human-readable byte counts. Binary units, because these are on-disk sizes. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unitIndex] ?? 'B'}`;
}
