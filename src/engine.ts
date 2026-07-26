import { hostname } from 'node:os';

import { TreeWatcher, type FlushReason } from './core/watcher.js';
import { TimeloomError, describeUnknownError, isTimeloomError } from './errors.js';
import type { Logger } from './logger.js';
import type { Repository } from './repository.js';
import type { EngineEvent, SnapshotRecord } from './types.js';

/** How often the watch session thins old snapshots in the background. */
const AUTO_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Wait this long after a snapshot before probing it. Someone who just saved is
 * probably about to save again; probing immediately means every build is thrown away
 * a second later.
 */
const PROBE_SETTLE_MS = 1_500;

export interface WatchSessionOptions {
  repository: Repository;
  logger: Logger;
  /** Bound to the HTTP server's SSE stream when the UI is running. */
  onEvent?: (event: EngineEvent) => void;
  /** Disable background thinning; useful in tests. */
  autoPrune?: boolean;
  /** Port the UI is served on, recorded so other commands can find it. */
  port?: number;
}

/**
 * The long-running half of timeloom: watch, snapshot, probe, thin, repeat.
 *
 * Kept separate from {@link Repository} because the repository is a set of
 * operations and this is a policy — when to snapshot, when a health check is worth
 * running, when history has grown enough to thin. Tests drive the repository
 * directly; only this class needs timers.
 */
export class WatchSession {
  private readonly repository: Repository;
  private readonly logger: Logger;
  private watcher: TreeWatcher | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeAbort: AbortController | null = null;
  private lastProbeStartedAt = 0;
  private pendingProbeTarget: SnapshotRecord | null = null;
  private unsubscribe: (() => void) | null = null;
  private running = false;

  constructor(private readonly options: WatchSessionOptions) {
    this.repository = options.repository;
    this.logger = options.logger;
  }

  get mode(): 'native' | 'polling' | null {
    return this.watcher?.mode ?? null;
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (this.running) return;

    const existing = await this.repository.readDaemonInfo();
    if (existing !== null) {
      throw new TimeloomError(
        'LOCK_HELD',
        `timeloom is already watching this project (pid ${existing.pid})`,
        { hint: 'Stop that process first, or open the existing session in your browser.' },
      );
    }

    this.running = true;
    if (this.options.onEvent !== undefined) {
      const forward = this.options.onEvent;
      this.unsubscribe = this.repository.on(forward);
    }

    await this.repository.writeDaemonInfo({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port: this.options.port ?? null,
      root: this.repository.root,
    });

    this.watcher = new TreeWatcher({
      root: this.repository.root,
      config: this.repository.config,
      logger: this.logger.child('watch'),
      matcher: this.repository.ignoreMatcher,
      onFlush: (paths, reason) => this.handleFlush(paths, reason),
      onError: (error) => {
        this.logger.error(`Snapshot failed: ${describeUnknownError(error)}`);
        this.options.onEvent?.({ type: 'error', message: describeUnknownError(error) });
      },
    });
    this.watcher.start();

    // Catch up on anything that changed while nothing was watching.
    this.watcher.requestFlush('startup');

    if (this.options.autoPrune ?? true) {
      this.pruneTimer = setInterval(() => {
        void this.runPrune();
      }, AUTO_PRUNE_INTERVAL_MS);
      this.pruneTimer.unref();
    }

    this.logger.info(
      `Watching ${this.repository.root}${this.watcher.mode === 'polling' ? ' (periodic scan mode)' : ''}`,
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
    }
    if (this.probeTimer !== null) {
      clearTimeout(this.probeTimer);
      this.probeTimer = null;
    }
    this.probeAbort?.abort();
    this.probeAbort = null;

    await this.watcher?.stop();
    this.watcher = null;

    this.unsubscribe?.();
    this.unsubscribe = null;

    await this.repository.clearDaemonInfo();
    this.logger.info('Stopped watching');
  }

  /** Snapshot right now, bypassing the quiet period. */
  requestSnapshot(): void {
    this.watcher?.requestFlush('manual');
  }

  private async handleFlush(paths: ReadonlySet<string>, reason: FlushReason): Promise<void> {
    this.options.onEvent?.({
      type: 'watch-status',
      watching: true,
      pendingPaths: paths.size,
    });

    let outcome;
    try {
      outcome = await this.repository.snapshot({
        trigger: reason === 'reconcile' ? 'reconcile' : 'watch',
      });
    } catch (error) {
      // Losing the race for the lock is normal — a restore is in progress. The next
      // flush will pick the change up, so this is not worth alarming the user about.
      if (isTimeloomError(error) && error.code === 'LOCK_HELD') {
        this.logger.debug('skipped a snapshot: repository is busy');
        return;
      }
      throw error;
    }

    if (outcome.snapshot === null) {
      this.logger.debug(`No changes after ${reason} (${paths.size} path(s) touched)`);
      return;
    }

    this.logger.debug(`Snapshot ${outcome.snapshot.id} (${reason})`);
    this.scheduleProbe(outcome.snapshot);
  }

  /**
   * Queue a health check for the newest snapshot.
   *
   * Probes are expensive — a real build — so they are rate-limited and always target
   * the newest snapshot: a verdict about code the user has already changed is not
   * worth waiting for. An in-flight probe is cancelled the moment it becomes stale.
   */
  private scheduleProbe(record: SnapshotRecord): void {
    const { health } = this.repository.config;
    if (!health.enabled || health.command === null) return;

    this.pendingProbeTarget = record;
    if (this.probeTimer !== null) clearTimeout(this.probeTimer);

    const sinceLast = Date.now() - this.lastProbeStartedAt;
    const delay = Math.max(PROBE_SETTLE_MS, health.minIntervalMs - sinceLast);

    this.probeTimer = setTimeout(() => {
      this.probeTimer = null;
      void this.runProbe();
    }, delay);
    this.probeTimer.unref();
  }

  private async runProbe(): Promise<void> {
    const target = this.pendingProbeTarget;
    if (target === null || !this.running) return;
    this.pendingProbeTarget = null;

    this.probeAbort?.abort();
    const abort = new AbortController();
    this.probeAbort = abort;
    this.lastProbeStartedAt = Date.now();

    try {
      const result = await this.repository.checkHealth(target, abort.signal);
      if (result.status !== 'skipped') {
        this.logger.info(`Health check on ${target.id}: ${result.status}`);
      }
    } catch (error) {
      this.logger.warn(`Health check failed to run: ${describeUnknownError(error)}`);
    } finally {
      if (this.probeAbort === abort) this.probeAbort = null;
    }
  }

  private async runPrune(): Promise<void> {
    try {
      const result = await this.repository.prune();
      if (result.droppedSnapshots > 0) {
        this.logger.debug(
          `Thinned ${result.droppedSnapshots} snapshots, reclaimed ${result.reclaimedBytes} bytes`,
        );
      }
    } catch (error) {
      if (isTimeloomError(error) && error.code === 'LOCK_HELD') return;
      this.logger.warn(`Background cleanup failed: ${describeUnknownError(error)}`);
    }
  }
}

export function describeHost(): string {
  return hostname();
}
