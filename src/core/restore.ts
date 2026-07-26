import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { isErrno } from '../errors.js';
import type { Logger } from '../logger.js';
import type { FileChange, FileEntry, RestorePlan, RestoreWrite, SkippedFile } from '../types.js';
import { ensureDir, pruneEmptyDirsUpward, resolveWithin, syncDirectory } from '../util/fsx.js';
import type { ObjectStore } from './cas.js';
import { diffFileLists } from './diff.js';

export interface RestoreContext {
  root: string;
  store: ObjectStore;
  tmpDir: string;
  logger: Logger;
}

export interface ApplyRestoreResult {
  written: number;
  deleted: number;
  bytesWritten: number;
  /** Paths the restore deliberately declined to touch, with the reason. */
  skipped: { path: string; reason: string }[];
}

/**
 * Work out what restoring `target` over the current tree would do.
 *
 * Separated from applying it so the CLI can print the plan and ask, and so the UI
 * can show a preview. `timeloom restore` overwrites someone's working files; they
 * deserve to see the blast radius first.
 */
export function planRestore(
  targetId: string,
  current: readonly FileEntry[],
  target: readonly FileEntry[],
  untouched: readonly SkippedFile[],
): RestorePlan {
  const byPath = new Map(target.map((entry) => [entry.path, entry]));
  const changes = diffFileLists(current, target);

  const write: RestoreWrite[] = [];
  const remove: FileChange[] = [];

  for (const change of changes) {
    if (change.status === 'deleted') {
      // Present now, absent in the target: restoring means removing it.
      remove.push(change);
      continue;
    }
    const entry = byPath.get(change.path);
    if (entry === undefined) continue;
    write.push({ change, entry });
  }

  return { targetId, write, delete: remove, untouched: [...untouched] };
}

/**
 * Apply a restore plan to the working tree.
 *
 * Deletions run before writes so a path that was a file and is now a directory (or
 * the reverse) can change shape. Empty directories are cleaned up at the very end
 * rather than during deletion, so a directory that is about to be repopulated is not
 * removed and recreated.
 *
 * Nothing here follows a symlink. A store is data, and data that can make a write
 * land outside the project is a vulnerability, not a feature.
 */
export async function applyRestore(
  context: RestoreContext,
  plan: RestorePlan,
  signal?: AbortSignal,
): Promise<ApplyRestoreResult> {
  const { root, store, tmpDir, logger } = context;
  const skipped: { path: string; reason: string }[] = [];
  const emptied = new Set<string>();
  let written = 0;
  let deleted = 0;
  let bytesWritten = 0;

  for (const change of plan.delete) {
    signal?.throwIfAborted();
    const absolute = resolveWithin(root, change.path);
    const stat = await lstatOrNull(absolute);
    if (stat === null) continue;
    if (stat.isSymbolicLink()) {
      skipped.push({ path: change.path, reason: 'is a symbolic link' });
      continue;
    }
    if (!stat.isFile()) {
      skipped.push({ path: change.path, reason: 'is not a regular file' });
      continue;
    }
    await fs.rm(absolute, { force: true });
    emptied.add(path.dirname(absolute));
    deleted += 1;
  }

  for (const item of plan.write) {
    signal?.throwIfAborted();
    const absolute = resolveWithin(root, item.entry.path);
    const stat = await lstatOrNull(absolute);
    if (stat?.isSymbolicLink() === true) {
      skipped.push({ path: item.entry.path, reason: 'is a symbolic link' });
      continue;
    }
    if (stat?.isDirectory() === true) {
      skipped.push({ path: item.entry.path, reason: 'a directory is in the way' });
      continue;
    }

    const data = await store.get(item.entry.hash);
    await ensureDir(path.dirname(absolute));
    await writeFileAtomically(absolute, data, tmpDir, logger);

    if (process.platform !== 'win32') {
      // Restoring a shell script without its executable bit produces a project that
      // looks correct and does not run.
      await fs.chmod(absolute, item.entry.executable ? 0o755 : 0o644).catch(() => undefined);
    }

    written += 1;
    bytesWritten += data.byteLength;
  }

  for (const dir of emptied) {
    await pruneEmptyDirsUpward(root, dir);
  }

  if (skipped.length > 0) {
    logger.warn(`Left ${skipped.length} path(s) untouched during restore`, skipped);
  }

  return { written, deleted, bytesWritten, skipped };
}

async function lstatOrNull(target: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT', 'ENOTDIR')) return null;
    throw error;
  }
}

/**
 * Write via a temporary file and a rename, so an interrupted restore never leaves a
 * half-written source file behind.
 *
 * The rename is what makes it atomic, and rename only works within one filesystem.
 * `.timeloom/tmp` is normally on the same volume as the project, but a project with
 * a bind-mounted or symlinked subdirectory breaks that assumption — hence the EXDEV
 * fallback to a temp file beside the target.
 */
async function writeFileAtomically(
  target: string,
  data: Buffer,
  tmpDir: string,
  logger: Logger,
): Promise<void> {
  await ensureDir(tmpDir);
  const primaryTmp = path.join(tmpDir, `r-${randomUUID()}`);
  try {
    await writeThenRename(primaryTmp, target, data);
    return;
  } catch (error) {
    if (!isErrno(error, 'EXDEV')) {
      await fs.rm(primaryTmp, { force: true }).catch(() => undefined);
      throw error;
    }
    logger.debug('cross-device rename; falling back to a sibling temp file', target);
    await fs.rm(primaryTmp, { force: true }).catch(() => undefined);
  }

  const siblingTmp = path.join(path.dirname(target), `.timeloom-tmp-${randomUUID()}`);
  try {
    await writeThenRename(siblingTmp, target, data);
  } catch (error) {
    await fs.rm(siblingTmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeThenRename(tmpPath: string, target: string, data: Buffer): Promise<void> {
  const handle = await fs.open(tmpPath, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmpPath, target);
  await syncDirectory(path.dirname(target));
}
