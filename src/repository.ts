import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import {
  defaultConfig,
  loadConfig,
  saveConfig,
  type Language,
  type TimeloomConfig,
} from './config.js';
import { ObjectStore } from './core/cas.js';
import { summarizeChanges } from './core/describe.js';
import { countChanges, diffFileLists } from './core/diff.js';
import { runHealthProbe } from './core/health.js';
import type { IgnoreMatcher } from './core/ignore.js';
import { acquireLock, type LockHandle } from './core/lock.js';
import { applyPrune, planPrune } from './core/prune.js';
import { applyRestore, planRestore } from './core/restore.js';
import { buildIgnoreMatcher, scanTree } from './core/scanner.js';
import { StatCache } from './core/statcache.js';
import { SnapshotIndex, type SnapshotPatch } from './core/store.js';
import { TimeloomError, isErrno } from './errors.js';
import { silentLogger, type Logger } from './logger.js';
import { repoPaths, STORE_DIRNAME, type RepoPaths } from './paths.js';
import type {
  DaemonInfo,
  DiffResult,
  EngineEvent,
  FileEntry,
  HealthResult,
  PrunePlan,
  PruneResult,
  RepositoryStatus,
  RestorePlan,
  RestoreResult,
  ScanResult,
  SnapshotRecord,
  SnapshotTrigger,
  Tree,
} from './types.js';
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from './util/fsx.js';

/** How long a routine operation waits for the repository lock before giving up. */
const LOCK_WAIT_SNAPSHOT_MS = 8_000;
const LOCK_WAIT_MUTATION_MS = 30_000;

export interface OpenRepositoryOptions {
  logger?: Logger;
  /** Override the on-disk config. Used by the CLI for one-shot flags. */
  config?: TimeloomConfig;
}

export interface InitRepositoryOptions extends OpenRepositoryOptions {
  language?: Language;
  /** Add `.timeloom/` to the project's .gitignore. Default true. */
  updateGitignore?: boolean;
  /** Probe command to record, or null to leave health checking disabled. */
  healthCommand?: string | null;
}

export interface SnapshotOptions {
  trigger: SnapshotTrigger;
  label?: string | null;
  /** Record a snapshot even when the tree is byte-identical to the previous one. */
  force?: boolean;
  signal?: AbortSignal;
}

export interface SnapshotOutcome {
  /** Null when nothing changed and `force` was not set. */
  snapshot: SnapshotRecord | null;
  scan: ScanResult;
  parent: SnapshotRecord | null;
}

export interface RestoreOptions {
  /** Take a snapshot of the current state first. Default true; turning it off is destructive. */
  safetySnapshot?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export type EngineListener = (event: EngineEvent) => void;

/**
 * A timeloom-tracked project.
 *
 * Everything that touches the store goes through here, which is what lets the CLI,
 * the HTTP API and the watch daemon share one set of invariants instead of three.
 *
 * Concurrency model, stated plainly because it is the thing most likely to bite:
 * the object store is content-addressed and the index is append-only, so *writes*
 * from two processes are safe on their own. What is not safe is one process
 * rewriting the working tree while another reads it, or a garbage collector deleting
 * an object a concurrent snapshot just decided to reference. Both are covered by a
 * short-lived exclusive lock taken around snapshot, restore and prune. The watcher
 * takes and releases it per snapshot rather than holding it, so `timeloom restore`
 * in a second terminal works while `timeloom watch` is running.
 */
export class Repository {
  private listeners = new Set<EngineListener>();
  private matcher: IgnoreMatcher;

  private constructor(
    readonly paths: RepoPaths,
    private currentConfig: TimeloomConfig,
    private readonly index: SnapshotIndex,
    private readonly store: ObjectStore,
    private readonly statCache: StatCache,
    private readonly logger: Logger,
  ) {
    this.matcher = buildIgnoreMatcher(currentConfig);
  }

  get config(): TimeloomConfig {
    return this.currentConfig;
  }

  get root(): string {
    return this.paths.root;
  }

  get objectStore(): ObjectStore {
    return this.store;
  }

  /** The shared ignore matcher. Handed to the watcher so both see identical rules. */
  get ignoreMatcher(): IgnoreMatcher {
    return this.matcher;
  }

  /** Rebuild ignore rules, picking up `.gitignore` edits made since the last scan. */
  refreshIgnoreRules(): IgnoreMatcher {
    this.matcher = buildIgnoreMatcher(this.currentConfig);
    return this.matcher;
  }

  /**
   * Walk up from `startDir` looking for a `.timeloom` directory, the way git finds
   * its root. Lets `timeloom list` work from anywhere inside the project.
   */
  static async find(startDir: string): Promise<string | null> {
    let current = path.resolve(startDir);
    for (;;) {
      if (await pathExists(path.join(current, STORE_DIRNAME))) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }

  static async isInitialized(root: string): Promise<boolean> {
    return pathExists(repoPaths(root).config);
  }

  static async init(root: string, options: InitRepositoryOptions = {}): Promise<Repository> {
    const paths = repoPaths(root);
    const logger = options.logger ?? silentLogger;

    if (await pathExists(paths.config)) {
      throw new TimeloomError('ALREADY_INITIALIZED', `${paths.store} already exists`, {
        hint: 'This project is already tracked. Run `timeloom status` to see it.',
      });
    }
    if (!(await pathExists(paths.root))) {
      throw new TimeloomError('IO', `${paths.root} does not exist`);
    }

    await ensureDir(paths.store);
    await ensureDir(paths.objects);
    await ensureDir(paths.tmp);

    // Belt and braces against the single worst outcome for this tool: a user pushing
    // their entire snapshot history — which contains every version of every file,
    // including whatever secrets they have ever had in a .env — to a public repo.
    // A `*` inside the store works even if the project has no .gitignore at all.
    await fs.writeFile(
      paths.storeGitignore,
      '# Written by timeloom. This directory holds full copies of your files.\n*\n',
      'utf8',
    );

    const config = options.config ?? defaultConfig(options.language);
    if (options.healthCommand !== undefined && options.healthCommand !== null) {
      config.health = { ...config.health, enabled: true, command: options.healthCommand };
    }
    await saveConfig(paths.root, config);

    if (options.updateGitignore ?? true) {
      await addToProjectGitignore(paths.root, logger);
    }

    const repository = await Repository.open(paths.root, { logger, config });
    await repository.snapshot({ trigger: 'init', force: true });
    return repository;
  }

  static async open(root: string, options: OpenRepositoryOptions = {}): Promise<Repository> {
    const paths = repoPaths(root);
    const logger = options.logger ?? silentLogger;

    if (!(await pathExists(paths.store))) {
      throw new TimeloomError('NOT_INITIALIZED', `${paths.root} is not tracked by timeloom`, {
        hint: 'Run `timeloom init` here first.',
      });
    }

    const config = options.config ?? (await loadConfig(paths.root));
    await ensureDir(paths.objects);
    await ensureDir(paths.tmp);

    const store = new ObjectStore(paths.objects, paths.tmp);
    const index = await SnapshotIndex.open(paths.index, paths.tmp, logger);
    const statCache = await StatCache.load(paths.statCache);

    return new Repository(paths, config, index, store, statCache, logger);
  }

  on(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.debug('event listener threw', error);
      }
    }
  }

  async setConfig(config: TimeloomConfig): Promise<void> {
    this.currentConfig = config;
    this.refreshIgnoreRules();
    await saveConfig(this.paths.root, config);
  }

  /**
   * Capture the current state of the tree.
   *
   * Returns `snapshot: null` when nothing changed, which is the common case: the
   * watcher fires on every burst of writes, and most of those turn out to be a
   * formatter rewriting a file to exactly what it already was.
   */
  async snapshot(options: SnapshotOptions): Promise<SnapshotOutcome> {
    const lock = await this.lock('snapshot', LOCK_WAIT_SNAPSHOT_MS);
    try {
      const outcome = await this.snapshotLocked(options);
      await this.index.compactIfNeeded();
      await this.statCache.save(this.paths.statCache, this.paths.tmp);
      return outcome;
    } finally {
      await lock.release();
    }
  }

  list(): SnapshotRecord[] {
    return this.index.list();
  }

  get(id: string): SnapshotRecord | null {
    return this.index.get(id);
  }

  resolve(reference: string): SnapshotRecord {
    return this.index.resolve(reference);
  }

  latest(): SnapshotRecord | null {
    return this.index.latest();
  }

  lastHealthy(): SnapshotRecord | null {
    return this.index.lastHealthy();
  }

  async update(id: string, patch: SnapshotPatch): Promise<SnapshotRecord> {
    return this.index.update(id, patch);
  }

  /** The file list a snapshot recorded. */
  async filesOf(record: SnapshotRecord): Promise<FileEntry[]> {
    const tree = await this.store.getJson<Tree>(record.treeHash);
    return tree.files;
  }

  /**
   * Compare two snapshots, or a snapshot against what is on disk right now
   * (`to = null`).
   */
  async diff(fromReference: string | null, toReference: string | null): Promise<DiffResult> {
    const from = fromReference === null ? null : this.index.resolve(fromReference);
    const to = toReference === null ? null : this.index.resolve(toReference);

    const before = from === null ? [] : await this.filesOf(from);
    const after = to === null ? (await this.scanWorkingTree()).files : await this.filesOf(to);

    const changes = diffFileLists(before, after);
    return {
      fromId: from?.id ?? null,
      toId: to?.id ?? null,
      changes,
      counts: countChanges(changes),
    };
  }

  /** Read the working tree without writing anything. Used by status and diff. */
  async scanWorkingTree(signal?: AbortSignal): Promise<{ files: FileEntry[]; scan: ScanResult }> {
    const files: FileEntry[] = [];
    const scan = await scanTree({
      root: this.paths.root,
      config: this.currentConfig,
      statCache: this.statCache,
      logger: this.logger,
      matcher: this.matcher,
      ...(signal !== undefined ? { signal } : {}),
      onFile: (entry) => {
        files.push(entry);
      },
    });
    return { files, scan };
  }

  async planRestore(reference: string, signal?: AbortSignal): Promise<RestorePlan> {
    const target = this.index.resolve(reference);
    const targetFiles = await this.filesOf(target);
    const { files, scan } = await this.scanWorkingTree(signal);
    return planRestore(target.id, files, targetFiles, scan.skipped);
  }

  /**
   * Put the working tree back to how a snapshot found it.
   *
   * A safety snapshot is taken first, unconditionally by default. The entire premise
   * of this tool is that undo should always be available — including undo of the
   * undo, which is exactly what a panicking user reaches for thirty seconds later.
   */
  async restore(reference: string, options: RestoreOptions = {}): Promise<RestoreResult> {
    const startedAt = Date.now();
    const target = this.index.resolve(reference);
    const lock = await this.lock('restore', LOCK_WAIT_MUTATION_MS);

    try {
      const targetFiles = await this.filesOf(target);

      let safetyId: string | null = null;
      if ((options.safetySnapshot ?? true) && options.dryRun !== true) {
        const safety = await this.snapshotLocked({
          trigger: 'pre-restore',
          label: null,
          force: false,
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        safetyId = safety.snapshot?.id ?? safety.parent?.id ?? null;
      }

      const { files, scan } = await this.scanWorkingTree(options.signal);
      const plan = planRestore(target.id, files, targetFiles, scan.skipped);

      if (options.dryRun === true) {
        return {
          targetId: target.id,
          safetySnapshotId: safetyId,
          written: plan.write.length,
          deleted: plan.delete.length,
          bytesWritten: plan.write.reduce((sum, item) => sum + item.entry.size, 0),
          durationMs: Date.now() - startedAt,
        };
      }

      const applied = await applyRestore(
        {
          root: this.paths.root,
          store: this.store,
          tmpDir: this.paths.tmp,
          logger: this.logger,
        },
        plan,
        options.signal,
      );

      // Every touched file now has a new mtime, so its cached hash is a lie.
      this.statCache.forget([
        ...plan.write.map((item) => item.entry.path),
        ...plan.delete.map((change) => change.path),
      ]);
      await this.statCache.save(this.paths.statCache, this.paths.tmp);

      // Record where we landed, so `latest` describes what is actually on disk and
      // the next automatic snapshot does not report the restore as a huge new edit.
      await this.recordRestorePoint(target, files, targetFiles);

      const result: RestoreResult = {
        targetId: target.id,
        safetySnapshotId: safetyId,
        written: applied.written,
        deleted: applied.deleted,
        bytesWritten: applied.bytesWritten,
        durationMs: Date.now() - startedAt,
      };
      this.emit({ type: 'restore', result });
      return result;
    } finally {
      await lock.release();
    }
  }

  private async recordRestorePoint(
    target: SnapshotRecord,
    before: readonly FileEntry[],
    after: readonly FileEntry[],
  ): Promise<void> {
    const parent = this.index.latest();
    const changes = diffFileLists(before, after);
    const { id, seq } = this.index.allocate();
    await this.index.add({
      id,
      seq,
      createdAt: new Date().toISOString(),
      treeHash: target.treeHash,
      parentId: parent?.id ?? null,
      fileCount: after.length,
      totalBytes: after.reduce((sum, entry) => sum + entry.size, 0),
      trigger: 'restore',
      label: null,
      pinned: false,
      summary: summarizeChanges(changes),
      // Restoring a snapshot restores its verdict too: the bytes are identical, so
      // whatever the probe concluded about them still holds.
      health: target.health,
    });
  }

  planPrune(now = Date.now()): PrunePlan {
    return planPrune({
      records: this.index.list(),
      retention: this.currentConfig.retention,
      now,
    });
  }

  async prune(options: { now?: number; signal?: AbortSignal } = {}): Promise<PruneResult> {
    const lock = await this.lock('prune', LOCK_WAIT_MUTATION_MS);
    try {
      const plan = this.planPrune(options.now ?? Date.now());
      const result = await applyPrune({
        index: this.index,
        store: this.store,
        plan,
        logger: this.logger,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      await this.index.compactIfNeeded(true);
      this.emit({ type: 'prune', result });
      return result;
    } finally {
      await lock.release();
    }
  }

  /** Run the configured health command and attach the verdict to `record`. */
  async checkHealth(record: SnapshotRecord, signal?: AbortSignal): Promise<HealthResult> {
    const { health } = this.currentConfig;
    if (!health.enabled || health.command === null) {
      const skipped: HealthResult = {
        status: 'skipped',
        command: health.command,
        exitCode: null,
        durationMs: 0,
        checkedAt: new Date().toISOString(),
        outputTail: '',
      };
      return skipped;
    }

    const result = await runHealthProbe({
      command: health.command,
      cwd: this.paths.root,
      timeoutMs: health.timeoutMs,
      successExitCodes: health.successExitCodes,
      logger: this.logger,
      ...(signal !== undefined ? { signal } : {}),
    });

    await this.index.update(record.id, { health: result });
    this.emit({ type: 'health', snapshotId: record.id, health: result });
    return result;
  }

  async status(signal?: AbortSignal): Promise<RepositoryStatus> {
    const latest = this.index.latest();
    const stats = await this.store.stats();

    let pendingChanges = null;
    if (latest !== null) {
      try {
        const [{ files }, previous] = await Promise.all([
          this.scanWorkingTree(signal),
          this.filesOf(latest),
        ]);
        pendingChanges = countChanges(diffFileLists(previous, files));
      } catch (error) {
        this.logger.debug('could not compute pending changes', error);
      }
    }

    return {
      root: this.paths.root,
      initialized: true,
      snapshotCount: this.index.size,
      latest,
      lastHealthy: this.index.lastHealthy(),
      daemon: await this.readDaemonInfo(),
      storeBytes: stats.totalBytes,
      objectCount: stats.objectCount,
      pendingChanges,
    };
  }

  async writeDaemonInfo(info: DaemonInfo): Promise<void> {
    await writeJsonFile(this.paths.daemon, info, this.paths.tmp);
  }

  async clearDaemonInfo(): Promise<void> {
    await fs.rm(this.paths.daemon, { force: true }).catch(() => undefined);
  }

  /** The running `timeloom watch`, or null. Stale records are cleaned up on read. */
  async readDaemonInfo(): Promise<DaemonInfo | null> {
    const info = await readJsonFile<DaemonInfo>(this.paths.daemon).catch(() => null);
    if (info === null || typeof info.pid !== 'number') return null;
    if (!isProcessAlive(info.pid)) {
      await this.clearDaemonInfo();
      return null;
    }
    return info;
  }

  async close(): Promise<void> {
    await this.statCache.save(this.paths.statCache, this.paths.tmp).catch(() => undefined);
    this.listeners.clear();
  }

  private async lock(purpose: string, waitMs: number): Promise<LockHandle> {
    return acquireLock(this.paths.lock, purpose, this.logger, { waitMs });
  }

  /**
   * Snapshot without taking the lock, for use inside an operation that already holds
   * it. Kept private because calling it from anywhere else reintroduces exactly the
   * race the lock exists to prevent.
   */
  private async snapshotLocked(options: SnapshotOptions): Promise<SnapshotOutcome> {
    const files: FileEntry[] = [];
    const scan = await scanTree({
      root: this.paths.root,
      config: this.currentConfig,
      statCache: this.statCache,
      logger: this.logger,
      matcher: this.matcher,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      isStored: (hash) => this.store.has(hash),
      onFile: async (entry, content) => {
        files.push(entry);
        if (content !== null) await this.store.put(content);
      },
    });

    const tree: Tree = { v: 1, files };
    const { hash: treeHash } = await this.store.putJson(tree);
    const parent = this.index.latest();

    if (parent !== null && parent.treeHash === treeHash && options.force !== true) {
      return { snapshot: null, scan, parent };
    }

    const parentFiles = parent === null ? [] : await this.filesOf(parent);
    const changes = diffFileLists(parentFiles, files);
    const { id, seq } = this.index.allocate();
    const record: SnapshotRecord = {
      id,
      seq,
      createdAt: new Date().toISOString(),
      treeHash,
      parentId: parent?.id ?? null,
      fileCount: files.length,
      totalBytes: files.reduce((sum, entry) => sum + entry.size, 0),
      trigger: options.trigger,
      label: options.label ?? null,
      pinned: false,
      summary: summarizeChanges(changes),
      health: null,
    };
    await this.index.add(record);
    this.emit({ type: 'snapshot', snapshot: record });
    return { snapshot: record, scan, parent };
  }
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

/**
 * Make sure `.timeloom/` is in the project's .gitignore.
 *
 * The store contains a verbatim copy of every version of every tracked file. A user
 * who commits it has published their history — and any secret that was ever in it —
 * without realising. This is the one side effect `init` performs on the user's own
 * files, and it is worth it.
 */
export async function addToProjectGitignore(root: string, logger: Logger): Promise<boolean> {
  const gitignorePath = path.join(root, '.gitignore');
  const entry = `${STORE_DIRNAME}/`;

  let existing = '';
  try {
    existing = await fs.readFile(gitignorePath, 'utf8');
  } catch (error) {
    if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
  }

  const alreadyListed = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line === entry || line === STORE_DIRNAME || line === `/${entry}`);
  if (alreadyListed) return false;

  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsNewline ? '\n' : ''}\n# timeloom's snapshot store — never commit this\n${entry}\n`;
  await fs.appendFile(gitignorePath, addition, 'utf8');
  logger.debug(`added ${entry} to .gitignore`);
  return true;
}

/**
 * Guess a health command from what the project looks like.
 *
 * Deliberately conservative: a wrong guess makes every snapshot look broken, which
 * is worse than not checking at all. Only script names whose whole purpose is to
 * fail on bad code are considered.
 */
export async function detectHealthCommand(root: string): Promise<string | null> {
  const packageJsonPath = path.join(root, 'package.json');
  const manifest = await readJsonFile<{ scripts?: Record<string, string> }>(packageJsonPath).catch(
    () => null,
  );
  const scripts = manifest?.scripts;
  if (scripts !== undefined) {
    for (const candidate of ['typecheck', 'build', 'compile', 'lint']) {
      if (typeof scripts[candidate] === 'string') return `npm run ${candidate}`;
    }
  }

  if (await pathExists(path.join(root, 'tsconfig.json'))) {
    return 'npx tsc --noEmit';
  }
  if (await pathExists(path.join(root, 'pyproject.toml'))) {
    return 'python -m compileall -q .';
  }
  if (await pathExists(path.join(root, 'Cargo.toml'))) {
    return 'cargo check';
  }
  if (await pathExists(path.join(root, 'go.mod'))) {
    return 'go build ./...';
  }
  return null;
}
