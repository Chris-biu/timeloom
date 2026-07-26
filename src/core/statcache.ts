import { readJsonFile, writeJsonFile } from '../util/fsx.js';

/**
 * How recently a file may have been written before we stop trusting its cached hash.
 *
 * The failure this guards against is git's "racily clean" problem: a file modified
 * twice within the same filesystem timestamp tick, ending at the same size, is
 * indistinguishable from an unmodified one by stat alone. Treating anything touched
 * near the scan boundary as dirty costs one re-hash of files the user just edited —
 * which is exactly the set we were going to hash anyway — and removes the class of
 * bug where a snapshot silently records stale content.
 */
const RACE_WINDOW_MS = 2_000;

export interface StatCacheEntry {
  size: number;
  mtimeMs: number;
  hash: string;
}

/** Compact on-disk shape: tuples rather than objects, for trees with 10k+ files. */
interface StatCacheFile {
  v: 1;
  savedAt: number;
  entries: Record<string, [size: number, mtimeMs: number, hash: string]>;
}

/**
 * Remembers `path -> (size, mtime, hash)` so an unchanged file is never re-read.
 *
 * On a 5,000-file project this is the difference between a snapshot costing ~40ms
 * and costing several seconds — which in turn is what makes snapshotting on every
 * quiet period practical rather than something the user notices and disables.
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class StatCache {
  private readonly entries: Map<string, StatCacheEntry>;
  private dirty = false;

  private constructor(entries: Map<string, StatCacheEntry>) {
    this.entries = entries;
  }

  static empty(): StatCache {
    return new StatCache(new Map());
  }

  static async load(file: string): Promise<StatCache> {
    // Read as `unknown`, not as `StatCacheFile`. The cache is a file on disk that a
    // user can edit and an older version may have written differently; declaring the
    // shape we hope for would make every check below dead code to the compiler and
    // live code at runtime.
    const raw: unknown = await readJsonFile<unknown>(file).catch(() => null);
    const entries = new Map<string, StatCacheEntry>();

    const file_ = raw as { v?: unknown; entries?: unknown } | null;
    if (file_ !== null && file_.v === 1 && isPlainObject(file_.entries)) {
      for (const [path, tuple] of Object.entries(file_.entries)) {
        if (!Array.isArray(tuple) || tuple.length !== 3) continue;
        const [size, mtimeMs, hash] = tuple as unknown[];
        if (typeof size !== 'number' || typeof mtimeMs !== 'number' || typeof hash !== 'string') {
          continue;
        }
        entries.set(path, { size, mtimeMs, hash });
      }
    }
    return new StatCache(entries);
  }

  get size(): number {
    return this.entries.size;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * The cached hash for a file whose stat still matches, or null if it must be read.
   * `scanStartedAtMs` anchors the racily-clean window.
   */
  lookup(repoPath: string, size: number, mtimeMs: number, scanStartedAtMs: number): string | null {
    const entry = this.entries.get(repoPath);
    if (entry === undefined) return null;
    if (entry.size !== size || entry.mtimeMs !== mtimeMs) return null;
    if (mtimeMs >= scanStartedAtMs - RACE_WINDOW_MS) return null;
    return entry.hash;
  }

  remember(repoPath: string, entry: StatCacheEntry): void {
    const existing = this.entries.get(repoPath);
    if (
      existing?.size === entry.size &&
      existing.mtimeMs === entry.mtimeMs &&
      existing.hash === entry.hash
    ) {
      return;
    }
    this.entries.set(repoPath, entry);
    this.dirty = true;
  }

  /**
   * Invalidate specific paths. Restore rewrites files behind the scanner's back, so
   * their cached (size, mtime, hash) triple no longer describes what is on disk.
   */
  forget(repoPaths: Iterable<string>): void {
    for (const repoPath of repoPaths) {
      if (this.entries.delete(repoPath)) this.dirty = true;
    }
  }

  /** Drop entries for files that no longer exist, so the cache cannot grow forever. */
  retainOnly(livePaths: ReadonlySet<string>): void {
    for (const path of this.entries.keys()) {
      if (!livePaths.has(path)) {
        this.entries.delete(path);
        this.dirty = true;
      }
    }
  }

  async save(file: string, tmpDir: string): Promise<void> {
    if (!this.dirty) return;
    const entries: StatCacheFile['entries'] = {};
    for (const [path, entry] of this.entries) {
      entries[path] = [entry.size, entry.mtimeMs, entry.hash];
    }
    const payload: StatCacheFile = { v: 1, savedAt: Date.now(), entries };
    await writeJsonFile(file, payload, tmpDir);
    this.dirty = false;
  }
}
