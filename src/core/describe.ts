import type { Language } from '../config.js';
import { catalog } from '../i18n.js';
import type { FileChange, FileChangeStatus, SnapshotSummary } from '../types.js';
import { commonDirectory, dominantKind } from './classify.js';
import { countChanges } from './diff.js';

/** How many representative paths a summary carries. Enough to recognise, few enough to scan. */
const MAX_SAMPLE_PATHS = 5;

/**
 * A modified file says more about what someone was working on than a deleted one, and
 * a deletion is usually collateral. This ordering decides which paths get shown.
 */
const STATUS_RANK: Record<FileChangeStatus, number> = {
  modified: 0,
  added: 1,
  deleted: 2,
};

/**
 * Reduce a diff to the description shown next to a snapshot.
 *
 * Computed once at snapshot time and stored, because it needs to survive pruning of
 * the parent snapshot that produced it — a description that can only be regenerated
 * from a tree we deleted is not a description.
 */
export function summarizeChanges(changes: readonly FileChange[]): SnapshotSummary {
  const counts = countChanges(changes);
  if (changes.length === 0) {
    return { counts, samplePaths: [], scope: null, kind: 'none' };
  }

  const paths = changes.map((change) => change.path);
  const kind = dominantKind(paths);
  const scope = commonDirectory(paths);

  const ranked = [...changes].sort((a, b) => {
    const byStatus = STATUS_RANK[a.status] - STATUS_RANK[b.status];
    if (byStatus !== 0) return byStatus;
    // Shallower paths are more likely to be the file someone would name.
    const depthDelta = depth(a.path) - depth(b.path);
    if (depthDelta !== 0) return depthDelta;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return {
    counts,
    samplePaths: ranked.slice(0, MAX_SAMPLE_PATHS).map((change) => change.path),
    scope,
    kind,
  };
}

export function formatSummary(summary: SnapshotSummary, language: Language): string {
  return catalog(language).summary({
    counts: summary.counts,
    scope: summary.scope,
    kind: summary.kind,
  });
}

function depth(path: string): number {
  let count = 0;
  for (const character of path) {
    if (character === '/') count += 1;
  }
  return count;
}
