import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { DEFAULT_IGNORE, type TimeloomConfig } from '../config.js';
import { isErrno } from '../errors.js';
import type { Logger } from '../logger.js';
import { STORE_DIRNAME } from '../paths.js';
import type { FileEntry, ScanResult, SkippedFile } from '../types.js';
import { fromRepoPath } from '../util/fsx.js';
import { ObjectStore } from './cas.js';
import { IgnoreMatcher } from './ignore.js';
import type { StatCache } from './statcache.js';

/**
 * Invoked for every tracked file as it is discovered.
 *
 * `content` is the file's bytes when they had to be read, and null when the hash
 * came from the stat cache. Handing the buffer over here means the snapshot builder
 * never reads the same file twice.
 */
export type FileVisitor = (entry: FileEntry, content: Buffer | null) => Promise<void> | void;

export interface ScanOptions {
  root: string;
  config: TimeloomConfig;
  statCache: StatCache;
  logger: Logger;
  onFile?: FileVisitor;
  /**
   * Lets the scanner notice that a cached hash is no longer backed by an object —
   * possible after a prune — and re-read the file instead of emitting a tree that
   * references a blob nobody can restore.
   */
  isStored?: (hash: string) => Promise<boolean>;
  /**
   * Reuse an existing matcher instead of building one. The watcher holds the same
   * instance so that the paths it filters and the paths the scanner tracks can never
   * drift apart. Nested ignore files discovered during the walk are folded into it
   * exactly once, so passing the same matcher to many scans is safe.
   */
  matcher?: IgnoreMatcher;
  signal?: AbortSignal;
}

/**
 * Assemble the ignore rules for one scan.
 *
 * Evaluation order, weakest to strongest: built-in defaults, then every `.gitignore`
 * in the tree shallowest-first (added by the walker as it descends), then the user's
 * `config.ignore`. A fresh matcher is built per scan so edits to a `.gitignore` take
 * effect on the next snapshot rather than on the next restart.
 */
export function buildIgnoreMatcher(config: TimeloomConfig): IgnoreMatcher {
  const matcher = new IgnoreMatcher();
  matcher.addPatterns('', DEFAULT_IGNORE, 'built-in');
  if (config.ignore.length > 0) {
    matcher.addFinalPatterns(config.ignore, 'config.ignore');
  }
  // Absolutely last, and in the final layer rather than the root bucket, so that
  // nothing can re-include it. `DEFAULT_IGNORE` also lists the store, but a rule in
  // the root bucket loses to a later rule in the same bucket — so a single
  // `!.timeloom/` line in a project's own .gitignore would put the store back in
  // scope, and every snapshot would then contain all previous snapshots.
  matcher.addFinalPatterns([`${STORE_DIRNAME}/`], 'built-in (snapshot store)');
  return matcher;
}

interface PendingDir {
  repoPath: string;
  absolutePath: string;
}

/**
 * Walk the project and produce the tracked file list.
 *
 * Iterative rather than recursive: a deeply nested `node_modules` that slipped past
 * the ignore rules should not be able to blow the stack.
 */
export async function scanTree(options: ScanOptions): Promise<ScanResult> {
  const { root, config, statCache, logger } = options;
  const startedAt = Date.now();
  const matcher = options.matcher ?? buildIgnoreMatcher(config);

  const files: FileEntry[] = [];
  const skipped: SkippedFile[] = [];
  const livePaths = new Set<string>();
  let hashedCount = 0;
  let cachedCount = 0;

  const stack: PendingDir[] = [{ repoPath: '', absolutePath: root }];

  while (stack.length > 0) {
    options.signal?.throwIfAborted();
    const dir = stack.pop();
    if (dir === undefined) break;

    let dirents;
    try {
      dirents = await fs.readdir(dir.absolutePath, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) continue;
      if (isErrno(error, 'EACCES', 'EPERM')) {
        skipped.push({ path: dir.repoPath, reason: 'unreadable', size: null });
        logger.debug('directory not readable', dir.repoPath);
        continue;
      }
      throw error;
    }

    // Nested ignore files must be registered before their siblings are judged.
    if (config.useGitignore && !matcher.hasIgnoreFile(dir.repoPath)) {
      const hasGitignore = dirents.some((entry) => entry.name === '.gitignore' && entry.isFile());
      if (hasGitignore) {
        try {
          const contents = await fs.readFile(path.join(dir.absolutePath, '.gitignore'), 'utf8');
          const label = dir.repoPath === '' ? '.gitignore' : `${dir.repoPath}/.gitignore`;
          matcher.addIgnoreFile(dir.repoPath, contents, label);
        } catch (error) {
          logger.debug('could not read .gitignore', { dir: dir.repoPath, error });
        }
      }
    }

    for (const dirent of dirents) {
      options.signal?.throwIfAborted();
      const repoPath = dir.repoPath === '' ? dirent.name : `${dir.repoPath}/${dirent.name}`;
      const absolutePath = path.join(dir.absolutePath, dirent.name);

      if (dirent.isSymbolicLink()) {
        // Following links risks escaping the project and looping. Recording them as
        // skipped means restore also leaves them alone, which is the safe default.
        if (!matcher.decideDirect(repoPath, false).ignored) {
          skipped.push({ path: repoPath, reason: 'symlink', size: null });
        }
        continue;
      }

      if (dirent.isDirectory()) {
        if (matcher.decideDirect(repoPath, true).ignored) continue;
        stack.push({ repoPath, absolutePath });
        continue;
      }

      if (!dirent.isFile()) {
        if (!matcher.decideDirect(repoPath, false).ignored) {
          skipped.push({ path: repoPath, reason: 'special', size: null });
        }
        continue;
      }

      if (matcher.decideDirect(repoPath, false).ignored) continue;

      let stat;
      try {
        stat = await fs.stat(absolutePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT', 'ENOTDIR')) continue;
        if (isErrno(error, 'EACCES', 'EPERM')) {
          skipped.push({ path: repoPath, reason: 'unreadable', size: null });
          continue;
        }
        throw error;
      }

      if (stat.size > config.maxFileBytes) {
        skipped.push({ path: repoPath, reason: 'too-large', size: stat.size });
        continue;
      }

      const executable = process.platform !== 'win32' && (stat.mode & 0o111) !== 0;
      const cachedHash = statCache.lookup(repoPath, stat.size, stat.mtimeMs, startedAt);

      if (
        cachedHash !== null &&
        (options.isStored === undefined || (await options.isStored(cachedHash)))
      ) {
        const entry: FileEntry = { path: repoPath, hash: cachedHash, size: stat.size, executable };
        files.push(entry);
        livePaths.add(repoPath);
        cachedCount += 1;
        await options.onFile?.(entry, null);
        continue;
      }

      let content: Buffer;
      try {
        content = await fs.readFile(absolutePath);
      } catch (error) {
        if (isErrno(error, 'ENOENT', 'ENOTDIR')) continue;
        if (isErrno(error, 'EACCES', 'EPERM', 'EBUSY')) {
          skipped.push({ path: repoPath, reason: 'unreadable', size: stat.size });
          continue;
        }
        throw error;
      }

      const hash = ObjectStore.hash(content);
      const entry: FileEntry = {
        path: repoPath,
        hash,
        size: content.byteLength,
        executable,
      };
      files.push(entry);
      livePaths.add(repoPath);
      hashedCount += 1;
      statCache.remember(repoPath, {
        size: content.byteLength,
        mtimeMs: stat.mtimeMs,
        hash,
      });
      await options.onFile?.(entry, content);
    }
  }

  statCache.retainOnly(livePaths);
  files.sort(compareByPath);
  skipped.sort(compareByPath);

  return {
    files,
    skipped,
    hashedCount,
    cachedCount,
    durationMs: Date.now() - startedAt,
  };
}

function compareByPath(a: { path: string }, b: { path: string }): number {
  if (a.path === b.path) return 0;
  return a.path < b.path ? -1 : 1;
}

/** Absolute on-disk location of a repo-relative path. */
export function absolutePathOf(root: string, repoPath: string): string {
  return path.join(root, fromRepoPath(repoPath));
}
