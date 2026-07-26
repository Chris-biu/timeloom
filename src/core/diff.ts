import type { ChangeCounts, FileChange, FileEntry } from '../types.js';

/**
 * Compare two file lists.
 *
 * Keyed by path through a Map rather than a sorted merge: both inputs happen to be
 * sorted today, but a diff that silently produces garbage when handed an unsorted
 * list is a trap, and the constant factor is irrelevant next to the I/O around it.
 */
export function diffFileLists(
  before: readonly FileEntry[],
  after: readonly FileEntry[],
): FileChange[] {
  const remaining = new Map<string, FileEntry>();
  for (const entry of before) remaining.set(entry.path, entry);

  const changes: FileChange[] = [];

  for (const entry of after) {
    const previous = remaining.get(entry.path);
    if (previous === undefined) {
      changes.push({
        path: entry.path,
        status: 'added',
        sizeBefore: null,
        sizeAfter: entry.size,
        hashBefore: null,
        hashAfter: entry.hash,
      });
      continue;
    }
    remaining.delete(entry.path);
    // The executable bit is part of a file's identity on POSIX: losing +x on a shell
    // script breaks the project just as thoroughly as losing a line of code.
    if (previous.hash !== entry.hash || previous.executable !== entry.executable) {
      changes.push({
        path: entry.path,
        status: 'modified',
        sizeBefore: previous.size,
        sizeAfter: entry.size,
        hashBefore: previous.hash,
        hashAfter: entry.hash,
      });
    }
  }

  for (const entry of remaining.values()) {
    changes.push({
      path: entry.path,
      status: 'deleted',
      sizeBefore: entry.size,
      sizeAfter: null,
      hashBefore: entry.hash,
      hashAfter: null,
    });
  }

  changes.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  return changes;
}

export function countChanges(changes: readonly FileChange[]): ChangeCounts {
  const counts: ChangeCounts = { added: 0, modified: 0, deleted: 0 };
  for (const change of changes) {
    counts[change.status] += 1;
  }
  return counts;
}

export function totalChanges(counts: ChangeCounts): number {
  return counts.added + counts.modified + counts.deleted;
}
