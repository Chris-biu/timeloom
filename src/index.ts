/**
 * timeloom's programmatic API.
 *
 * The CLI is a thin layer over this; anything the command line can do, an embedding
 * program can do too. Editor extensions and custom dashboards are the intended
 * consumers.
 *
 * ```ts
 * import { Repository } from 'timeloom';
 *
 * const repo = await Repository.open(process.cwd());
 * const { snapshot } = await repo.snapshot({ trigger: 'manual', label: 'before refactor' });
 * await repo.restore('healthy');
 * ```
 */

export {
  DEFAULT_IGNORE,
  defaultConfig,
  detectLanguage,
  isLoopbackHost,
  loadConfig,
  parseConfig,
  saveConfig,
  type HealthConfig,
  type Language,
  type RetentionConfig,
  type ServerConfig,
  type TimeloomConfig,
  type WatchConfig,
} from './config.js';

export { ObjectStore, type ObjectStoreStats, type PutResult } from './core/cas.js';
export { classifyPath, commonDirectory, dominantKind } from './core/classify.js';
export { formatSummary, summarizeChanges } from './core/describe.js';
export { countChanges, diffFileLists, totalChanges } from './core/diff.js';
export { TailBuffer, runHealthProbe, type HealthProbeOptions } from './core/health.js';
export {
  IgnoreMatcher,
  compileRule,
  parseIgnoreFile,
  type IgnoreDecision,
  type IgnoreRule,
} from './core/ignore.js';
export {
  acquireLock,
  type AcquireLockOptions,
  type LockHandle,
  type LockInfo,
} from './core/lock.js';
export { applyPrune, planPrune, type PlanPruneInput } from './core/prune.js';
export {
  applyRestore,
  planRestore,
  type ApplyRestoreResult,
  type RestoreContext,
} from './core/restore.js';
export {
  absolutePathOf,
  buildIgnoreMatcher,
  scanTree,
  type FileVisitor,
  type ScanOptions,
} from './core/scanner.js';
export { StatCache, type StatCacheEntry } from './core/statcache.js';
export { MIN_ID_PREFIX, SnapshotIndex, type SnapshotPatch } from './core/store.js';
export {
  TreeWatcher,
  type FlushReason,
  type TreeWatcherOptions,
  type WatchMode,
} from './core/watcher.js';

export { WatchSession, type WatchSessionOptions } from './engine.js';

export {
  TimeloomError,
  describeUnknownError,
  isTimeloomError,
  type TimeloomErrorCode,
} from './errors.js';

export { catalog, type Catalog, type SummaryInput } from './i18n.js';
export {
  LOG_LEVELS,
  createLogger,
  isLogLevel,
  silentLogger,
  type LogLevel,
  type Logger,
} from './logger.js';
export { STORE_DIRNAME, repoPaths, type RepoPaths } from './paths.js';

export {
  Repository,
  addToProjectGitignore,
  detectHealthCommand,
  type EngineListener,
  type InitRepositoryOptions,
  type OpenRepositoryOptions,
  type RestoreOptions,
  type SnapshotOptions,
  type SnapshotOutcome,
} from './repository.js';

export { startServer, type RunningServer, type ServerOptions } from './server/http.js';
export { toApiHealth, toApiSnapshot } from './server/present.js';
export type * from './server/api-types.js';

export type * from './types.js';
export { formatBytes, resolveWithin, toRepoPath } from './util/fsx.js';
export { ValidationError, Validator } from './util/validate.js';
export { readVersion } from './version.js';
