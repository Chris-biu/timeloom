import { watch, type FSWatcher } from 'node:fs';

import type { TimeloomConfig } from '../config.js';
import { describeUnknownError } from '../errors.js';
import type { Logger } from '../logger.js';
import { toRepoPath } from '../util/fsx.js';
import type { IgnoreMatcher } from './ignore.js';
import { buildIgnoreMatcher } from './scanner.js';

export type FlushReason = 'quiet' | 'max-wait' | 'reconcile' | 'manual' | 'startup';

export type WatchMode = 'native' | 'polling';

/** Ceiling on how long a degraded watcher may go without checking the tree. */
const POLLING_INTERVAL_MS = 15_000;

/**
 * Beyond this many distinct pending paths, tracking individual paths stops paying
 * for itself — the flush does a full scan regardless.
 */
const MAX_PENDING_PATHS = 20_000;

export interface TreeWatcherOptions {
  root: string;
  config: TimeloomConfig;
  logger: Logger;
  /** Invoked when the tree has settled. Never called concurrently with itself. */
  onFlush: (paths: ReadonlySet<string>, reason: FlushReason) => Promise<void>;
  onError?: (error: unknown) => void;
  /**
   * Share the scanner's matcher so event filtering sees the same rules the scan
   * does — including every nested `.gitignore`. Without it the watcher only knows
   * the built-in defaults, and every write under an ignored directory wakes it up.
   */
  matcher?: IgnoreMatcher;
}

/**
 * Turns a storm of filesystem events into a small number of useful moments.
 *
 * Three timers, each answering a different failure:
 *
 *   - **quiet period** — an AI agent rewriting fifteen files should produce one
 *     snapshot at the end, not fifteen snapshots of a half-edited project.
 *   - **max wait** — a project with a dev server writing to a log inside the tree
 *     would otherwise never go quiet, and never get snapshotted.
 *   - **reconcile** — recursive watchers silently drop events under load, on network
 *     drives, and inside containers. A periodic full scan is the only honest way to
 *     guarantee that what is on disk eventually reaches the store.
 *
 * If recursive watching is unavailable the watcher degrades to reconcile-only
 * polling rather than failing. Slower snapshots beat no snapshots.
 */
export class TreeWatcher {
  private watcher: FSWatcher | null = null;
  private matcher: IgnoreMatcher;
  private pending = new Set<string>();
  private quietTimer: NodeJS.Timeout | null = null;
  private maxWaitTimer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private flushing = false;
  private queuedReason: FlushReason | null = null;
  private stopped = false;
  private watchMode: WatchMode = 'native';
  private readonly ownsMatcher: boolean;

  constructor(private readonly options: TreeWatcherOptions) {
    this.ownsMatcher = options.matcher === undefined;
    this.matcher = options.matcher ?? buildIgnoreMatcher(options.config);
  }

  /** Swap in a rebuilt matcher, e.g. after the engine notices a `.gitignore` edit. */
  setMatcher(matcher: IgnoreMatcher): void {
    this.matcher = matcher;
  }

  get mode(): WatchMode {
    return this.watchMode;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  start(): void {
    if (this.watcher !== null || this.stopped) return;
    const { root, logger } = this.options;

    try {
      const watcher = watch(root, { recursive: true, persistent: true });
      watcher.on('change', (_eventType: string, filename: string | Buffer | null) => {
        this.handleRawEvent(filename);
      });
      watcher.on('error', (error) => {
        // A watcher error is not fatal — a deleted directory raises one on Windows —
        // but it does mean events may have been lost, so force a reconcile.
        logger.warn(`Filesystem watcher reported an error: ${describeUnknownError(error)}`);
        this.requestFlush('reconcile');
      });
      this.watcher = watcher;
      this.watchMode = 'native';
    } catch (error) {
      this.watchMode = 'polling';
      logger.warn(
        `Recursive file watching is not available here (${describeUnknownError(error)}); falling back to periodic scans every ${POLLING_INTERVAL_MS / 1000}s`,
      );
    }

    const configured = this.options.config.watch.reconcileIntervalMs;
    const interval =
      this.watchMode === 'polling'
        ? Math.min(configured > 0 ? configured : POLLING_INTERVAL_MS, POLLING_INTERVAL_MS)
        : configured;

    if (interval > 0) {
      this.reconcileTimer = setInterval(() => {
        this.refreshIgnoreRules();
        void this.flush('reconcile');
      }, interval);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearTimer('quietTimer');
    this.clearTimer('maxWaitTimer');
    if (this.reconcileTimer !== null) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
    this.watcher?.close();
    this.watcher = null;
    // Let an in-flight flush finish so we never stop mid-snapshot.
    while (this.flushing) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  /** Force a flush now, bypassing the quiet period. */
  requestFlush(reason: FlushReason = 'manual'): void {
    void this.flush(reason);
  }

  private handleRawEvent(filename: string | Buffer | null): void {
    if (this.stopped) return;

    if (filename === null) {
      // Some platforms report a change without saying what changed. A full scan is
      // the only correct response.
      this.schedule();
      return;
    }

    const relative = typeof filename === 'string' ? filename : filename.toString('utf8');
    if (relative.length === 0) {
      this.schedule();
      return;
    }

    const repoPath = toRepoPath(relative);
    // Evaluated with file semantics, which still walks ancestors — that is what
    // filters the flood of events from inside `node_modules` and `.next`.
    if (this.matcher.decide(repoPath, false).ignored) return;

    if (this.pending.size < MAX_PENDING_PATHS) {
      this.pending.add(repoPath);
    }
    this.schedule();
  }

  private schedule(): void {
    this.clearTimer('quietTimer');
    const { quietPeriodMs, maxWaitMs } = this.options.config.watch;

    this.quietTimer = setTimeout(() => {
      void this.flush('quiet');
    }, quietPeriodMs);

    this.maxWaitTimer ??= setTimeout(() => {
      void this.flush('max-wait');
    }, maxWaitMs);
  }

  private async flush(reason: FlushReason): Promise<void> {
    if (this.stopped && reason !== 'manual') return;

    if (this.flushing) {
      // Collapse concurrent requests: one more pass after the current one is enough,
      // because the pass reads the tree as it is at that moment.
      this.queuedReason = reason;
      return;
    }

    this.clearTimer('quietTimer');
    this.clearTimer('maxWaitTimer');

    const paths = this.pending;
    this.pending = new Set();

    const isForced = reason === 'reconcile' || reason === 'manual' || reason === 'startup';
    if (paths.size === 0 && !isForced) return;

    this.flushing = true;
    try {
      await this.options.onFlush(paths, reason);
    } catch (error) {
      if (this.options.onError !== undefined) {
        this.options.onError(error);
      } else {
        this.options.logger.error(`Snapshot failed: ${describeUnknownError(error)}`);
      }
    } finally {
      this.flushing = false;
      const queued = this.queuedReason;
      this.queuedReason = null;
      if (queued !== null && !this.stopped) {
        void this.flush(queued);
      }
    }
  }

  /**
   * Pick up edits to `.gitignore` without requiring a restart. When the engine owns
   * the matcher it is responsible for refreshing it, so this does nothing.
   */
  private refreshIgnoreRules(): void {
    if (!this.ownsMatcher) return;
    this.matcher = buildIgnoreMatcher(this.options.config);
  }

  private clearTimer(which: 'quietTimer' | 'maxWaitTimer'): void {
    const timer = this[which];
    if (timer !== null) {
      clearTimeout(timer);
      this[which] = null;
    }
  }
}
