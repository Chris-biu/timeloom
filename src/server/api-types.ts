/**
 * The HTTP API contract.
 *
 * This file is the source of truth shared with the web UI. Everything the frontend
 * renders is pre-formatted here — localised summary text, relative timestamps,
 * human-readable sizes — so the UI never has to reimplement timeloom's vocabulary
 * and the two can never disagree about what a snapshot "says".
 */

import type {
  ChangeCounts,
  ChangeKind,
  DiffResult,
  FileChange,
  HealthStatus,
  PruneResult,
  RestoreResult,
  SnapshotTrigger,
} from '../types.js';

export interface ApiSnapshot {
  id: string;
  seq: number;
  createdAt: string;
  /** Localised, e.g. "3 minutes ago" or "3 分钟前". */
  createdAtRelative: string;
  parentId: string | null;
  trigger: SnapshotTrigger;
  triggerLabel: string;
  label: string | null;
  pinned: boolean;
  fileCount: number;
  totalBytes: number;
  totalBytesHuman: string;
  /** Localised one-liner, e.g. "Edited 3 files in src/components · UI". */
  summaryText: string;
  counts: ChangeCounts;
  samplePaths: string[];
  scope: string | null;
  kind: ChangeKind;
  health: ApiHealth | null;
}

export interface ApiHealth {
  status: HealthStatus;
  statusLabel: string;
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  checkedAt: string;
  outputTail: string;
}

export interface ApiStatus {
  root: string;
  projectName: string;
  snapshotCount: number;
  latest: ApiSnapshot | null;
  lastHealthy: ApiSnapshot | null;
  watching: boolean;
  watchMode: 'native' | 'polling' | null;
  storeBytes: number;
  storeBytesHuman: string;
  objectCount: number;
  /** Uncommitted-equivalent: what has changed on disk since the latest snapshot. */
  pendingChanges: ChangeCounts | null;
  health: {
    enabled: boolean;
    command: string | null;
  };
  language: string;
  version: string;
}

export interface ApiSnapshotList {
  snapshots: ApiSnapshot[];
  total: number;
}

export interface ApiSnapshotDetail {
  snapshot: ApiSnapshot;
  /** Diff against the parent snapshot; empty for the very first one. */
  changes: FileChange[];
}

export interface ApiDiff extends DiffResult {
  fromLabel: string;
  toLabel: string;
}

export interface ApiRestorePreview {
  targetId: string;
  willWrite: FileChange[];
  willDelete: FileChange[];
  untouched: { path: string; reason: string }[];
}

export interface ApiRestoreResponse {
  result: RestoreResult;
  /** The snapshot taken just before restoring, so the UI can offer "undo this undo". */
  safetySnapshotId: string | null;
}

export interface ApiPruneResponse {
  result: PruneResult;
}

export interface ApiFileContent {
  path: string;
  size: number;
  /** Null when the file is not valid UTF-8; the UI shows a "binary file" placeholder. */
  text: string | null;
  truncated: boolean;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    hint: string | null;
  };
}
