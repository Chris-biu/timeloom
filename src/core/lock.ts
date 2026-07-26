import { hostname } from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TimeloomError, isErrno } from '../errors.js';
import type { Logger } from '../logger.js';
import { ensureDir } from '../util/fsx.js';

export interface LockInfo {
  pid: number;
  host: string;
  startedAt: string;
  purpose: string;
}

export interface LockHandle {
  readonly info: LockInfo;
  release(): Promise<void>;
}

/**
 * An advisory exclusive lock over a repository.
 *
 * `timeloom watch` runs for hours while the user also types `timeloom restore` in
 * another terminal. Two processes mutating the object store concurrently is fine —
 * it is content-addressed — but two processes rewriting the working tree is not.
 *
 * Implemented with `O_EXCL` file creation, which is atomic on every filesystem that
 * matters. The interesting part is the failure mode everyone forgets: a lock left
 * behind by a process that was killed. Stale locks are detected by probing the
 * recorded pid and broken automatically, but only when the lock was taken on this
 * same machine — a pid from another host says nothing about a process here.
 */
export interface AcquireLockOptions {
  /**
   * How long to keep trying before giving up. The watcher takes this lock around
   * every snapshot while the user may be running `restore` in another terminal, so
   * contention is normal and brief — failing instantly would drop snapshots for no
   * reason.
   */
  waitMs?: number;
  pollMs?: number;
}

export async function acquireLock(
  lockPath: string,
  purpose: string,
  logger: Logger,
  options: AcquireLockOptions = {},
): Promise<LockHandle> {
  const waitMs = options.waitMs ?? 0;
  const pollMs = options.pollMs ?? 100;
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      return await tryAcquire(lockPath, purpose, logger);
    } catch (error) {
      const canRetry =
        error instanceof TimeloomError && error.code === 'LOCK_HELD' && Date.now() < deadline;
      if (!canRetry) throw error;
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
}

async function tryAcquire(lockPath: string, purpose: string, logger: Logger): Promise<LockHandle> {
  const info: LockInfo = {
    pid: process.pid,
    host: hostname(),
    startedAt: new Date().toISOString(),
    purpose,
  };

  await ensureDir(path.dirname(lockPath));

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, 'wx');
      try {
        await handle.writeFile(JSON.stringify(info), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return makeHandle(lockPath, info, logger);
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) throw error;

      const existing = await readLockInfo(lockPath);
      if (existing === null) {
        // Either a torn write or someone removed it between our open and read.
        // Both are safe to retry once.
        await fs.rm(lockPath, { force: true });
        continue;
      }

      if (isHolderAlive(existing)) {
        throw new TimeloomError(
          'LOCK_HELD',
          `Another timeloom process is using this project (${existing.purpose}, pid ${existing.pid})`,
          {
            hint:
              existing.host === hostname()
                ? 'Stop it first, or wait for it to finish.'
                : `The lock was taken on host "${existing.host}". If that machine is gone, delete ${lockPath}.`,
          },
        );
      }

      logger.debug(`breaking stale lock from pid ${existing.pid}`);
      await fs.rm(lockPath, { force: true });
    }
  }

  throw new TimeloomError('LOCK_HELD', 'Could not take the repository lock', {
    hint: `Delete ${lockPath} if you are sure no other timeloom process is running.`,
  });
}

function makeHandle(lockPath: string, info: LockInfo, logger: Logger): LockHandle {
  let released = false;
  return {
    info,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      // Only remove the lock if it is still ours. If a stale-lock breaker handed it
      // to someone else while we were running, deleting it would strand them.
      const current = await readLockInfo(lockPath);
      if (current !== null && (current.pid !== info.pid || current.startedAt !== info.startedAt)) {
        logger.debug('lock changed hands; leaving it alone');
        return;
      }
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}

async function readLockInfo(lockPath: string): Promise<LockInfo | null> {
  let raw: string;
  try {
    raw = await fs.readFile(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (typeof parsed.pid !== 'number' || typeof parsed.host !== 'string') return null;
    return {
      pid: parsed.pid,
      host: parsed.host,
      startedAt: typeof parsed.startedAt === 'string' ? parsed.startedAt : '',
      purpose: typeof parsed.purpose === 'string' ? parsed.purpose : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Is the process that took this lock still running?
 *
 * `kill(pid, 0)` performs the permission check without delivering a signal: it
 * throws ESRCH when nothing has that pid and EPERM when something does but it
 * belongs to another user. EPERM therefore means *alive*, which is the case a naive
 * try/catch gets backwards.
 */
function isHolderAlive(info: LockInfo): boolean {
  if (info.host !== hostname()) return true;
  if (!Number.isInteger(info.pid) || info.pid <= 0) return false;
  if (info.pid === process.pid) return true;
  try {
    process.kill(info.pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}
