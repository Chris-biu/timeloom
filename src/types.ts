/**
 * Wire and on-disk types.
 *
 * Everything here is JSON-serialisable and forms the contract between the engine,
 * the `.timeloom/` store on disk, the HTTP API, and the web UI. Absent values are
 * modelled as `null` rather than optional properties so that a round-trip through
 * `JSON.stringify` is lossless and `exactOptionalPropertyTypes` stays satisfiable.
 */

/** One tracked file inside a snapshot's tree. */
export interface FileEntry {
  /** Repository-relative, always POSIX-separated. */
  path: string;
  /** SHA-256 of the file's exact bytes, hex-encoded. */
  hash: string;
  size: number;
  /** Preserved across platforms; meaningless on Windows but restored on POSIX. */
  executable: boolean;
}

/** The full file list of one snapshot. Stored in the object store, so identical trees dedupe. */
export interface Tree {
  v: 1;
  files: FileEntry[];
}

export type SnapshotTrigger = 'init' | 'manual' | 'watch' | 'pre-restore' | 'restore' | 'reconcile';

export const SNAPSHOT_TRIGGERS: readonly SnapshotTrigger[] = [
  'init',
  'manual',
  'watch',
  'pre-restore',
  'restore',
  'reconcile',
];

/**
 * Result of running the configured health probe against a snapshot.
 *
 * `skipped` means probing is off or was suppressed by debouncing; `error` means the
 * probe itself could not be launched (bad command, missing binary), which is
 * distinct from the project being broken.
 */
export type HealthStatus = 'healthy' | 'broken' | 'timeout' | 'error' | 'skipped';

export interface HealthResult {
  status: HealthStatus;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  checkedAt: string;
  /** Last few lines of combined stdout+stderr, truncated. Enough to see the error. */
  outputTail: string;
}

export interface ChangeCounts {
  added: number;
  modified: number;
  deleted: number;
}

/**
 * Coarse classification of what a change touched, derived purely from paths.
 * Used to render a description a non-programmer can recognise their own work in.
 */
export type ChangeKind =
  'none' | 'ui' | 'style' | 'logic' | 'config' | 'deps' | 'docs' | 'test' | 'assets' | 'mixed';

export interface SnapshotSummary {
  counts: ChangeCounts;
  /** Representative changed paths, most significant first. Bounded in length. */
  samplePaths: string[];
  /** Deepest directory containing every changed file, or null when they diverge. */
  scope: string | null;
  kind: ChangeKind;
}

export interface SnapshotRecord {
  /** Short, URL-safe, collision-checked. Users type a prefix of this. */
  id: string;
  /** Monotonic per-repository counter. Ordering key; `createdAt` can go backwards. */
  seq: number;
  createdAt: string;
  treeHash: string;
  parentId: string | null;
  fileCount: number;
  totalBytes: number;
  trigger: SnapshotTrigger;
  /** User-supplied name. Labelled snapshots are never auto-pruned. */
  label: string | null;
  /** Explicit keep-forever flag, independent of labelling. */
  pinned: boolean;
  summary: SnapshotSummary;
  health: HealthResult | null;
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted';

export interface FileChange {
  path: string;
  status: FileChangeStatus;
  sizeBefore: number | null;
  sizeAfter: number | null;
  hashBefore: string | null;
  hashAfter: string | null;
}

export interface DiffResult {
  fromId: string | null;
  toId: string | null;
  changes: FileChange[];
  counts: ChangeCounts;
}

/** A file that exists on disk but was deliberately not tracked. Surfaced to the user. */
export interface SkippedFile {
  path: string;
  reason: 'too-large' | 'symlink' | 'unreadable' | 'special';
  size: number | null;
}

export interface ScanResult {
  files: FileEntry[];
  skipped: SkippedFile[];
  /** Files whose content had to be re-read because the stat cache missed. */
  hashedCount: number;
  /** Files served entirely from the stat cache. */
  cachedCount: number;
  durationMs: number;
}

/**
 * One file the restore will write. Carries both the diff entry (what the UI shows)
 * and the target tree entry (what the applier needs — notably the executable bit,
 * which a diff record has no place for).
 */
export interface RestoreWrite {
  change: FileChange;
  entry: FileEntry;
}

export interface RestorePlan {
  targetId: string;
  write: RestoreWrite[];
  delete: FileChange[];
  /** Files present on disk but skipped by scanning; restore will not touch them. */
  untouched: SkippedFile[];
}

export interface RestoreResult {
  targetId: string;
  safetySnapshotId: string | null;
  written: number;
  deleted: number;
  bytesWritten: number;
  durationMs: number;
}

export interface PrunePlan {
  keep: string[];
  drop: string[];
  reasons: Record<string, string>;
}

export interface PruneResult {
  droppedSnapshots: number;
  deletedObjects: number;
  reclaimedBytes: number;
}

export interface RepositoryStatus {
  root: string;
  initialized: boolean;
  snapshotCount: number;
  latest: SnapshotRecord | null;
  lastHealthy: SnapshotRecord | null;
  /** Non-null when a `timeloom watch` process holds the lock. */
  daemon: DaemonInfo | null;
  storeBytes: number;
  objectCount: number;
  /** Changes on disk that are not in the latest snapshot yet. */
  pendingChanges: ChangeCounts | null;
}

export interface DaemonInfo {
  pid: number;
  startedAt: string;
  port: number | null;
  root: string;
}

/** Events pushed to the web UI over SSE. */
export type EngineEvent =
  | { type: 'snapshot'; snapshot: SnapshotRecord }
  | { type: 'health'; snapshotId: string; health: HealthResult }
  | { type: 'restore'; result: RestoreResult }
  | { type: 'prune'; result: PruneResult }
  | { type: 'watch-status'; watching: boolean; pendingPaths: number }
  | { type: 'error'; message: string };
