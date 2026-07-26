import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { TimeloomError, isErrno } from '../errors.js';
import type { Logger } from '../logger.js';
import type { HealthResult, SnapshotRecord } from '../types.js';
import { atomicWriteFile, ensureDir } from '../util/fsx.js';

export interface SnapshotPatch {
  label?: string | null;
  pinned?: boolean;
  health?: HealthResult | null;
}

type IndexEvent =
  | { t: 'add'; s: SnapshotRecord }
  | { t: 'del'; id: string }
  | { t: 'set'; id: string; p: SnapshotPatch };

/** Rewrite the log once it holds this much redundancy over the live record count. */
const COMPACT_RATIO = 2;
const COMPACT_FLOOR = 64;

/** Shortest prefix a user may type to identify a snapshot. */
export const MIN_ID_PREFIX = 3;

/**
 * The snapshot index.
 *
 * Stored as an append-only event log rather than a rewritten document. Snapshots are
 * created on a timer while the user is working, so the write path has to stay cheap
 * and — more importantly — has to be crash-safe: a half-written JSON document would
 * take the entire history with it, whereas a torn final line of a log costs one
 * snapshot. The log is replayed on open and compacted once it accumulates enough
 * superseded events.
 */
export class SnapshotIndex {
  private readonly records = new Map<string, SnapshotRecord>();
  private eventCount = 0;
  private nextSeq = 1;
  /**
   * True when the log on disk does not end in a newline — the signature of a write
   * interrupted mid-line. The next append prefixes one, so the torn fragment stays
   * confined to its own line instead of swallowing the record written after it.
   */
  private needsNewlinePrefix = false;

  private constructor(
    private readonly indexPath: string,
    private readonly tmpDir: string,
    private readonly logger: Logger,
  ) {}

  static async open(indexPath: string, tmpDir: string, logger: Logger): Promise<SnapshotIndex> {
    const index = new SnapshotIndex(indexPath, tmpDir, logger);
    await index.replay();
    return index;
  }

  private async replay(): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.indexPath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return;
      throw error;
    }

    // A log that does not end in a newline was cut off mid-write. Appending straight
    // onto it would glue the next event to the fragment and produce one unparseable
    // line, losing a second snapshot — the one the user was just told had been taken.
    this.needsNewlinePrefix = raw.length > 0 && !raw.endsWith('\n');

    let lineNumber = 0;
    let malformed = 0;
    for (const line of raw.split('\n')) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        // A torn last line is the expected shape of a crash; anything earlier is
        // genuine corruption. Neither is worth losing the rest of the history over.
        malformed += 1;
        continue;
      }
      this.eventCount += 1;
      this.apply(event, lineNumber);
    }

    if (malformed > 0) {
      this.logger.warn(
        `Skipped ${malformed} unreadable line(s) in the snapshot index; history before and after them is intact`,
      );
    }
    for (const record of this.records.values()) {
      this.nextSeq = Math.max(this.nextSeq, record.seq + 1);
    }
  }

  /**
   * Apply one replayed line.
   *
   * Takes `unknown` rather than `IndexEvent` deliberately. What arrives is whatever
   * `JSON.parse` made of a plain text file that a user can edit and a crash can
   * half-write — `null`, a number, an object missing half its fields. Declaring the
   * parameter as the type we *hope* for is how a single `null` line turns an
   * otherwise intact store into one that no timeloom command can open.
   */
  private apply(event: unknown, lineNumber: number): void {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      this.logger.debug(`Snapshot index line ${lineNumber} is not an event; skipping`);
      return;
    }

    const fields = event as { t?: unknown; s?: unknown; id?: unknown; p?: unknown };
    if (typeof fields.t !== 'string') {
      this.logger.debug(`Snapshot index line ${lineNumber} has no event kind; skipping`);
      return;
    }

    switch (fields.t) {
      case 'add': {
        if (!isSnapshotRecord(fields.s)) {
          this.logger.warn(`Snapshot index line ${lineNumber} is not a valid record; skipping`);
          return;
        }
        this.records.set(fields.s.id, fields.s);
        return;
      }
      case 'del': {
        if (typeof fields.id !== 'string') return;
        this.records.delete(fields.id);
        return;
      }
      case 'set': {
        if (typeof fields.id !== 'string') return;
        const existing = this.records.get(fields.id);
        if (existing === undefined) return;
        const patch = sanitizePatch(fields.p);
        if (patch === null) {
          this.logger.debug(`Snapshot index line ${lineNumber} has no usable patch; skipping`);
          return;
        }
        this.records.set(fields.id, applyPatch(existing, patch));
        return;
      }
      default: {
        // Forward compatibility: a newer timeloom may write event kinds we do not
        // know. Ignoring them keeps the store readable in both directions.
        this.logger.debug(`Ignoring unknown index event at line ${lineNumber}`);
      }
    }
  }

  get size(): number {
    return this.records.size;
  }

  /** Snapshots in creation order, oldest first. */
  list(): SnapshotRecord[] {
    return [...this.records.values()].sort((a, b) => a.seq - b.seq);
  }

  get(id: string): SnapshotRecord | null {
    return this.records.get(id) ?? null;
  }

  latest(): SnapshotRecord | null {
    let best: SnapshotRecord | null = null;
    for (const record of this.records.values()) {
      if (best === null || record.seq > best.seq) best = record;
    }
    return best;
  }

  /** Newest snapshot whose health probe passed, or null if none ever did. */
  lastHealthy(): SnapshotRecord | null {
    let best: SnapshotRecord | null = null;
    for (const record of this.records.values()) {
      if (record.health?.status !== 'healthy') continue;
      if (best === null || record.seq > best.seq) best = record;
    }
    return best;
  }

  /**
   * Turn whatever the user typed into a snapshot.
   *
   * Accepts a full id, a unique prefix, `latest`/`head`, `healthy` for the last
   * known-working snapshot, `~N` for N steps back, and `#seq` for the raw counter.
   * A beginner reaching for this tool is usually panicking; `timeloom restore healthy`
   * needs to work without them having to read a list first.
   */
  resolve(reference: string): SnapshotRecord {
    const query = reference.trim();
    if (query.length === 0) {
      throw new TimeloomError('SNAPSHOT_NOT_FOUND', 'No snapshot given');
    }

    const lower = query.toLowerCase();

    if (lower === 'latest' || lower === 'head' || lower === 'last') {
      const latest = this.latest();
      if (latest === null) throw noSnapshots();
      return latest;
    }

    if (lower === 'healthy' || lower === 'working' || lower === 'last-healthy') {
      const healthy = this.lastHealthy();
      if (healthy === null) {
        throw new TimeloomError(
          'SNAPSHOT_NOT_FOUND',
          'No snapshot has ever passed the health check',
          {
            hint: 'Enable a health command with `timeloom config health.command "npm run build"`, or restore by id — `timeloom list` shows them.',
          },
        );
      }
      return healthy;
    }

    const stepsBack = /^(?:head)?~(\d+)$/.exec(lower);
    if (stepsBack !== null) {
      const ordered = this.list();
      const offset = Number.parseInt(stepsBack[1] ?? '0', 10);
      const target = ordered[ordered.length - 1 - offset];
      if (target === undefined) {
        throw new TimeloomError(
          'SNAPSHOT_NOT_FOUND',
          `There are only ${ordered.length} snapshots; cannot go back ${offset}`,
        );
      }
      return target;
    }

    const bySeq = /^#(\d+)$/.exec(lower);
    if (bySeq !== null) {
      const seq = Number.parseInt(bySeq[1] ?? '0', 10);
      for (const record of this.records.values()) {
        if (record.seq === seq) return record;
      }
      throw new TimeloomError('SNAPSHOT_NOT_FOUND', `No snapshot with sequence #${seq}`);
    }

    const exact = this.records.get(lower);
    if (exact !== undefined) return exact;

    // Fall back to a label match before treating the input as an id prefix, so a
    // snapshot the user named "before-refactor" can be restored by that name.
    const labelled = [...this.records.values()].filter(
      (record) => record.label !== null && record.label.toLowerCase() === lower,
    );
    const onlyLabelled = labelled[0];
    if (labelled.length === 1 && onlyLabelled !== undefined) return onlyLabelled;
    if (labelled.length > 1) {
      throw new TimeloomError('AMBIGUOUS_ID', `${labelled.length} snapshots are named "${query}"`, {
        hint: 'Use the snapshot id instead — `timeloom list` shows them.',
      });
    }

    if (lower.length < MIN_ID_PREFIX) {
      throw new TimeloomError(
        'SNAPSHOT_NOT_FOUND',
        `"${query}" is too short to identify a snapshot`,
        { hint: `Type at least ${MIN_ID_PREFIX} characters of the id.` },
      );
    }

    const matches = [...this.records.values()].filter((record) => record.id.startsWith(lower));
    const onlyMatch = matches[0];
    if (matches.length === 1 && onlyMatch !== undefined) return onlyMatch;
    if (matches.length > 1) {
      const ids = matches
        .slice(0, 5)
        .map((record) => record.id)
        .join(', ');
      throw new TimeloomError('AMBIGUOUS_ID', `"${query}" matches ${matches.length} snapshots`, {
        hint: `Add more characters. Candidates: ${ids}${matches.length > 5 ? ', ...' : ''}`,
      });
    }

    throw new TimeloomError('SNAPSHOT_NOT_FOUND', `No snapshot matches "${query}"`, {
      hint: 'Run `timeloom list` to see what is available.',
    });
  }

  /** Reserve the next id and sequence number. Ids are checked against live records. */
  allocate(): { id: string; seq: number } {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const id = randomBytes(4).toString('hex');
      if (!this.records.has(id)) {
        return { id, seq: this.nextSeq };
      }
    }
    // 2^32 ids with a store that holds thousands: never in practice, but silently
    // reusing an id would corrupt history, so widen rather than gamble.
    return { id: randomBytes(8).toString('hex'), seq: this.nextSeq };
  }

  async add(record: SnapshotRecord): Promise<SnapshotRecord> {
    this.records.set(record.id, record);
    this.nextSeq = Math.max(this.nextSeq, record.seq + 1);
    await this.appendEvent({ t: 'add', s: record });
    return record;
  }

  async update(id: string, patch: SnapshotPatch): Promise<SnapshotRecord> {
    const existing = this.records.get(id);
    if (existing === undefined) {
      throw new TimeloomError('SNAPSHOT_NOT_FOUND', `No snapshot with id ${id}`);
    }
    const updated = applyPatch(existing, patch);
    this.records.set(id, updated);
    await this.appendEvent({ t: 'set', id, p: patch });
    return updated;
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    for (const id of ids) this.records.delete(id);
    await this.appendEvents(ids.map((id) => ({ t: 'del', id }) satisfies IndexEvent));
    await this.compactIfNeeded();
  }

  private async appendEvent(event: IndexEvent): Promise<void> {
    await this.appendEvents([event]);
  }

  private async appendEvents(events: readonly IndexEvent[]): Promise<void> {
    if (events.length === 0) return;
    await ensureDir(path.dirname(this.indexPath));
    const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');
    const payload = this.needsNewlinePrefix ? `\n${body}` : body;
    this.needsNewlinePrefix = false;
    // Opened per write rather than held: `timeloom watch` and a one-off CLI command
    // can both be running, and O_APPEND on a per-write handle keeps their lines from
    // interleaving. fsync makes a snapshot durable the moment it is reported.
    const handle = await fs.open(this.indexPath, 'a');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    this.eventCount += events.length;
  }

  /** Rewrite the log as one `add` per live snapshot when redundancy has built up. */
  async compactIfNeeded(force = false): Promise<boolean> {
    const threshold = Math.max(COMPACT_FLOOR, this.records.size * COMPACT_RATIO);
    if (!force && this.eventCount <= threshold) return false;
    await this.compact();
    return true;
  }

  async compact(): Promise<void> {
    const lines = this.list()
      .map((record) => `${JSON.stringify({ t: 'add', s: record } satisfies IndexEvent)}\n`)
      .join('');
    await atomicWriteFile(this.indexPath, lines, this.tmpDir);
    this.eventCount = this.records.size;
    // Compaction rewrites the file wholesale, so whatever was torn is gone.
    this.needsNewlinePrefix = false;
    this.logger.debug(`Compacted snapshot index to ${this.records.size} records`);
  }
}

/**
 * Narrow a replayed patch payload, dropping any field that is not the right shape.
 *
 * Returns null when there is nothing usable at all. A `label` that arrived as a
 * number would otherwise be written straight into a record and then rendered by the
 * CLI, so each field is checked rather than trusted.
 */
function sanitizePatch(value: unknown): SnapshotPatch | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as { label?: unknown; pinned?: unknown; health?: unknown };
  const patch: SnapshotPatch = {};

  if (typeof raw.label === 'string' || raw.label === null) patch.label = raw.label;
  if (typeof raw.pinned === 'boolean') patch.pinned = raw.pinned;
  if (raw.health === null) {
    patch.health = null;
  } else if (typeof raw.health === 'object' && !Array.isArray(raw.health)) {
    patch.health = raw.health as HealthResult;
  }

  return Object.keys(patch).length === 0 ? null : patch;
}

function applyPatch(record: SnapshotRecord, patch: SnapshotPatch): SnapshotRecord {
  return {
    ...record,
    ...(patch.label !== undefined ? { label: patch.label } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(patch.health !== undefined ? { health: patch.health } : {}),
  };
}

function noSnapshots(): TimeloomError {
  return new TimeloomError('SNAPSHOT_NOT_FOUND', 'There are no snapshots yet', {
    hint: 'Run `timeloom watch` to start taking them automatically, or `timeloom snap` for one now.',
  });
}

/**
 * Shape-check a record read back from disk.
 *
 * The index is a plain file a user can edit, and a malformed record reaching the
 * restore path would be handed straight to the filesystem.
 */
function isSnapshotRecord(value: unknown): value is SnapshotRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  // Indexed as unknowns rather than cast to `Partial<SnapshotRecord>`: the partial
  // cast tells the compiler each field already has its declared type, which quietly
  // turns half these checks into dead code while they are the only thing standing
  // between a hand-edited index file and the restore path.
  const record = value as Record<string, unknown>;
  return (
    typeof record['id'] === 'string' &&
    record['id'].length > 0 &&
    typeof record['seq'] === 'number' &&
    typeof record['createdAt'] === 'string' &&
    typeof record['treeHash'] === 'string' &&
    typeof record['fileCount'] === 'number' &&
    typeof record['totalBytes'] === 'number' &&
    typeof record['pinned'] === 'boolean' &&
    typeof record['summary'] === 'object' &&
    record['summary'] !== null
  );
}
