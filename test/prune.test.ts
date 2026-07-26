import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RetentionConfig } from '../src/config.js';
import { ObjectStore } from '../src/core/cas.js';
import { applyPrune, planPrune } from '../src/core/prune.js';
import { SnapshotIndex } from '../src/core/store.js';
import { createLogger, silentLogger, type Logger } from '../src/logger.js';
import { repoPaths } from '../src/paths.js';
import type {
  FileEntry,
  HealthResult,
  HealthStatus,
  PrunePlan,
  SnapshotRecord,
  Tree,
} from '../src/types.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A fixed "now" that is an exact multiple of WEEK — and therefore of DAY, HOUR and
 * MINUTE too. planPrune buckets from the epoch, not from `now`, so anchoring the
 * tests on a boundary makes every expected bucket calculable by hand.
 * 2_800 * WEEK === 2023-08-31T00:00:00.000Z.
 */
const NOW = 2_800 * WEEK;

interface RecordSpec {
  id: string;
  seq: number;
  /** How long before NOW the snapshot was taken. Ignored when `createdAt` is given. */
  ageMs?: number;
  /** Raw override, for timestamps that cannot be parsed. */
  createdAt?: string;
  pinned?: boolean;
  label?: string | null;
  health?: HealthStatus;
  treeHash?: string;
}

function healthOf(status: HealthStatus): HealthResult {
  return {
    status,
    command: 'npm test',
    exitCode: status === 'healthy' ? 0 : 1,
    durationMs: 12,
    checkedAt: new Date(NOW).toISOString(),
    outputTail: '',
  };
}

function makeRecord(spec: RecordSpec): SnapshotRecord {
  // ISO strings round-trip through Date.parse without losing milliseconds, so the
  // bucket arithmetic in the source sees exactly NOW - ageMs.
  const createdAt = spec.createdAt ?? new Date(NOW - (spec.ageMs ?? 0)).toISOString();
  return {
    id: spec.id,
    seq: spec.seq,
    createdAt,
    treeHash: spec.treeHash ?? 'f'.repeat(64),
    parentId: null,
    fileCount: 0,
    totalBytes: 0,
    trigger: 'watch',
    label: spec.label ?? null,
    pinned: spec.pinned ?? false,
    summary: {
      counts: { added: 0, modified: 0, deleted: 0 },
      samplePaths: [],
      scope: null,
      kind: 'none',
    },
    health: spec.health === undefined ? null : healthOf(spec.health),
  };
}

/** Build records from ages alone, numbering `seq` so it always agrees with time. */
function timeline(entries: readonly { id: string; ageMs: number }[]): SnapshotRecord[] {
  return [...entries]
    .sort((a, b) => b.ageMs - a.ageMs)
    .map((entry, index) => makeRecord({ id: entry.id, seq: index + 1, ageMs: entry.ageMs }));
}

function retention(overrides: Partial<RetentionConfig> = {}): RetentionConfig {
  return {
    keepAllWithinMinutes: 60,
    hourlyForHours: 24,
    dailyForDays: 14,
    weeklyForWeeks: 8,
    maxSnapshots: 2_000,
    ...overrides,
  };
}

function plan(records: readonly SnapshotRecord[], config: RetentionConfig, now = NOW): PrunePlan {
  return planPrune({ records, retention: config, now });
}

/**
 * Invariants that must hold for every plan, whatever the input. Asserted from most
 * tests rather than once, because a rule that only holds for tidy inputs is not a rule.
 */
function expectWellFormed(result: PrunePlan, records: readonly SnapshotRecord[]): void {
  const keep = new Set(result.keep);
  const drop = new Set(result.drop);
  expect(keep.size).toBe(result.keep.length);
  expect(drop.size).toBe(result.drop.length);
  for (const id of result.keep) expect(drop.has(id)).toBe(false);
  const all = records.map((record) => record.id).sort();
  expect([...result.keep, ...result.drop].sort()).toEqual(all);
  for (const id of result.drop) {
    expect(result.reasons[id], `dropped ${id} must carry a reason`).toBeTypeOf('string');
  }
}

describe('planPrune', () => {
  it('returns an empty plan for an empty store', () => {
    const result = plan([], retention());
    expect(result).toEqual({ keep: [], drop: [], reasons: {} });
  });

  it('keeps every snapshot inside keepAllWithinMinutes, including one exactly on the boundary', () => {
    const records = timeline([
      { id: 'now', ageMs: 0 },
      { id: 'one-minute', ageMs: 1 * MINUTE },
      { id: 'half-hour', ageMs: 30 * MINUTE },
      { id: 'just-inside', ageMs: 59 * MINUTE },
      { id: 'on-the-boundary', ageMs: 60 * MINUTE },
    ]);

    const result = plan(records, retention({ keepAllWithinMinutes: 60 }));

    expect(result.drop).toEqual([]);
    expect([...result.keep].sort()).toEqual(
      ['half-hour', 'just-inside', 'now', 'on-the-boundary', 'one-minute'].sort(),
    );
    // The newest is protected as "latest"; the rest are held by the keep-all window.
    expect(result.reasons['now']).toBe('most recent snapshot');
    for (const id of ['one-minute', 'half-hour', 'just-inside', 'on-the-boundary']) {
      expect(result.reasons[id]).toBe('recent');
    }
    expectWellFormed(result, records);
  });

  it('keeps exactly one snapshot per hour bucket, and it is the newest of that hour', () => {
    // One snapshot alone in the most recent hour bucket (it is the protected
    // "latest"), then three per hour for the 23 hours before it.
    const entries = [{ id: 'latest', ageMs: 5 * MINUTE }];
    for (let hour = 1; hour <= 23; hour += 1) {
      for (const minute of [5, 25, 45]) {
        entries.push({ id: `h${hour}-m${minute}`, ageMs: hour * HOUR + minute * MINUTE });
      }
    }
    const records = timeline(entries);
    expect(records).toHaveLength(70);

    const result = plan(
      records,
      retention({
        keepAllWithinMinutes: 0,
        hourlyForHours: 24,
        dailyForDays: 0,
        weeklyForWeeks: 0,
      }),
    );

    const expected = ['latest'];
    for (let hour = 1; hour <= 23; hour += 1) expected.push(`h${hour}-m5`);
    expect([...result.keep].sort()).toEqual(expected.sort());

    for (let hour = 1; hour <= 23; hour += 1) {
      expect(result.reasons[`h${hour}-m5`]).toBe('newest snapshot of its hour');
      for (const minute of [25, 45]) {
        expect(result.reasons[`h${hour}-m${minute}`]).toBe(
          'superseded by a newer snapshot from the same hour',
        );
      }
    }
    expectWellFormed(result, records);
  });

  it('keeps exactly one snapshot per day bucket once the hourly window has passed', () => {
    const entries = [{ id: 'latest', ageMs: 1 * HOUR }];
    for (let day = 1; day <= 13; day += 1) {
      for (const hour of [1, 8, 20]) {
        entries.push({ id: `d${day}-h${hour}`, ageMs: day * DAY + hour * HOUR });
      }
    }
    const records = timeline(entries);

    const result = plan(
      records,
      retention({
        keepAllWithinMinutes: 0,
        hourlyForHours: 0,
        dailyForDays: 14,
        weeklyForWeeks: 0,
      }),
    );

    const expected = ['latest'];
    for (let day = 1; day <= 13; day += 1) expected.push(`d${day}-h1`);
    expect([...result.keep].sort()).toEqual(expected.sort());

    for (let day = 1; day <= 13; day += 1) {
      expect(result.reasons[`d${day}-h1`]).toBe('newest snapshot of its day');
      expect(result.reasons[`d${day}-h8`]).toBe('superseded by a newer snapshot from the same day');
      expect(result.reasons[`d${day}-h20`]).toBe(
        'superseded by a newer snapshot from the same day',
      );
    }
    expectWellFormed(result, records);
  });

  it('keeps exactly one snapshot per week bucket once the daily window has passed', () => {
    const entries = [{ id: 'latest', ageMs: 1 * DAY }];
    for (let week = 1; week <= 7; week += 1) {
      for (const day of [1, 3, 6]) {
        entries.push({ id: `w${week}-d${day}`, ageMs: week * WEEK + day * DAY });
      }
    }
    const records = timeline(entries);

    const result = plan(
      records,
      retention({ keepAllWithinMinutes: 0, hourlyForHours: 0, dailyForDays: 0, weeklyForWeeks: 8 }),
    );

    const expected = ['latest'];
    for (let week = 1; week <= 7; week += 1) expected.push(`w${week}-d1`);
    expect([...result.keep].sort()).toEqual(expected.sort());

    for (let week = 1; week <= 7; week += 1) {
      expect(result.reasons[`w${week}-d1`]).toBe('newest snapshot of its week');
      expect(result.reasons[`w${week}-d3`]).toBe(
        'superseded by a newer snapshot from the same week',
      );
    }
    expectWellFormed(result, records);
  });

  it('anchors buckets to the clock, so two snapshots ten minutes apart in different hours both survive', () => {
    // The bucket is floor(createdAt / HOUR), not a sliding window from `now`. Two
    // snapshots 50 minutes apart inside one clock hour collapse to one; two only 10
    // minutes apart that straddle the hour boundary are both kept. NOW is a whole
    // number of hours, so "age 2h55m" and "age 3h05m" sit either side of a boundary.
    const records = timeline([
      { id: 'latest', ageMs: 1 * MINUTE },
      { id: 'earlier-hour', ageMs: 3 * HOUR + 5 * MINUTE },
      { id: 'later-hour-old', ageMs: 2 * HOUR + 55 * MINUTE },
      { id: 'later-hour-new', ageMs: 2 * HOUR + 5 * MINUTE },
    ]);

    const result = plan(
      records,
      retention({
        keepAllWithinMinutes: 0,
        hourlyForHours: 24,
        dailyForDays: 0,
        weeklyForWeeks: 0,
      }),
    );

    expect([...result.keep].sort()).toEqual(['earlier-hour', 'later-hour-new', 'latest'].sort());
    // 50 minutes apart but the same clock hour: the older one loses.
    expect(result.drop).toEqual(['later-hour-old']);
    // 10 minutes apart but different clock hours: both survive.
    expect(result.reasons['earlier-hour']).toBe('newest snapshot of its hour');
    expect(result.reasons['later-hour-new']).toBe('newest snapshot of its hour');
    expectWellFormed(result, records);
  });

  it('picks the same snapshot out of each bucket when now advances, because buckets are anchored to the epoch', () => {
    // The stability guarantee the source calls out: running prune again a few minutes
    // later must not shift which snapshot represents each hour, or every run would
    // churn a different set of objects.
    const entries = [{ id: 'latest', ageMs: 30 * MINUTE }];
    for (let hour = 1; hour <= 12; hour += 1) {
      for (const minute of [3, 17, 51]) {
        entries.push({ id: `h${hour}-m${minute}`, ageMs: hour * HOUR + minute * MINUTE });
      }
    }
    const records = timeline(entries);
    const config = retention({
      keepAllWithinMinutes: 0,
      hourlyForHours: 24,
      dailyForDays: 0,
      weeklyForWeeks: 0,
    });

    const first = plan(records, config, NOW);
    const later = plan(records, config, NOW + 7 * MINUTE);

    // `latest` is protected in both runs, and every other survivor is the m3 of its
    // hour in both runs — the plan did not drift with the wall clock.
    expect([...later.keep].sort()).toEqual([...first.keep].sort());
    expect(later.reasons).toEqual(first.reasons);
    expectWellFormed(first, records);
    expectWellFormed(later, records);
  });

  it('drops anything older than the whole retention window', () => {
    // hourly 24h + daily 14d + weekly 8w == 1 + 14 + 56 == 71 days of window.
    const windowMs = 71 * DAY;
    const records = timeline([
      { id: 'newest', ageMs: 1 * MINUTE },
      { id: 'inside-window', ageMs: windowMs - 1 },
      { id: 'on-the-edge', ageMs: windowMs },
      { id: 'just-outside', ageMs: windowMs + 1 },
      { id: 'ancient', ageMs: 500 * DAY },
    ]);
    const config = retention({
      keepAllWithinMinutes: 0,
      hourlyForHours: 24,
      dailyForDays: 14,
      weeklyForWeeks: 8,
    });

    const result = plan(records, config);

    expect(result.keep).toContain('newest');
    expect(result.keep).toContain('inside-window');
    expect(result.drop).toContain('just-outside');
    expect(result.drop).toContain('ancient');
    expect(result.reasons['just-outside']).toBe('older than the retention window');
    expect(result.reasons['ancient']).toBe('older than the retention window');
    expectWellFormed(result, records);
  });

  it('keeps the most recent snapshot however old it is', () => {
    const records = [makeRecord({ id: 'only', seq: 1, ageMs: 10 * 365 * DAY })];

    const result = plan(records, retention());

    expect(result.keep).toEqual(['only']);
    expect(result.drop).toEqual([]);
    expect(result.reasons['only']).toBe('most recent snapshot');
    expectWellFormed(result, records);
  });

  it('keeps the most recent healthy snapshot even when it is far outside the window', () => {
    const records = [
      makeRecord({ id: 'oldest-healthy', seq: 1, ageMs: 6 * 365 * DAY, health: 'healthy' }),
      makeRecord({ id: 'newest-healthy', seq: 2, ageMs: 5 * 365 * DAY, health: 'healthy' }),
      makeRecord({ id: 'broken-since', seq: 3, ageMs: 4 * 365 * DAY, health: 'broken' }),
      makeRecord({ id: 'current', seq: 4, ageMs: 1 * MINUTE, health: 'broken' }),
    ];

    const result = plan(records, retention());

    expect(result.keep).toContain('current');
    expect(result.keep).toContain('newest-healthy');
    expect(result.reasons['newest-healthy']).toBe(
      'most recent snapshot that passed the health check',
    );
    // Only the *most recent* healthy snapshot is protected; older ones age out.
    expect(result.drop).toContain('oldest-healthy');
    expect(result.drop).toContain('broken-since');
    expectWellFormed(result, records);
  });

  it('does not double-protect when the most recent snapshot is itself the healthy one', () => {
    const records = [
      makeRecord({ id: 'older', seq: 1, ageMs: 3 * MINUTE }),
      makeRecord({ id: 'newest', seq: 2, ageMs: 1 * MINUTE, health: 'healthy' }),
    ];

    const result = plan(records, retention());

    expect(result.reasons['newest']).toBe('most recent snapshot');
    expect(result.keep).toContain('newest');
    expectWellFormed(result, records);
  });

  it('treats only a "healthy" verdict as healthy, not "skipped", "timeout" or "error"', () => {
    const records = [
      makeRecord({ id: 'skipped', seq: 1, ageMs: 5 * 365 * DAY, health: 'skipped' }),
      makeRecord({ id: 'timeout', seq: 2, ageMs: 4 * 365 * DAY, health: 'timeout' }),
      makeRecord({ id: 'errored', seq: 3, ageMs: 3 * 365 * DAY, health: 'error' }),
      makeRecord({ id: 'current', seq: 4, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention());

    expect([...result.drop].sort()).toEqual(['errored', 'skipped', 'timeout']);
    expectWellFormed(result, records);
  });

  it('never drops a pinned snapshot, at any age', () => {
    const records = [
      makeRecord({ id: 'pinned-ancient', seq: 1, ageMs: 40 * 365 * DAY, pinned: true }),
      makeRecord({ id: 'expendable', seq: 2, ageMs: 39 * 365 * DAY }),
      makeRecord({ id: 'current', seq: 3, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention());

    expect(result.keep).toContain('pinned-ancient');
    expect(result.reasons['pinned-ancient']).toBe('pinned');
    expect(result.drop).toEqual(['expendable']);
    expectWellFormed(result, records);
  });

  it('never drops a labelled snapshot, at any age, and names the label in the reason', () => {
    const records = [
      makeRecord({ id: 'labelled', seq: 1, ageMs: 40 * 365 * DAY, label: 'before-refactor' }),
      makeRecord({ id: 'empty-label', seq: 2, ageMs: 39 * 365 * DAY, label: '' }),
      makeRecord({ id: 'expendable', seq: 3, ageMs: 38 * 365 * DAY }),
      makeRecord({ id: 'current', seq: 4, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention());

    expect(result.keep).toContain('labelled');
    expect(result.reasons['labelled']).toBe('named "before-refactor"');
    // An empty string is still a label: the record was named, however uselessly.
    expect(result.keep).toContain('empty-label');
    expect(result.drop).toEqual(['expendable']);
    expectWellFormed(result, records);
  });

  it('keeps a pinned snapshot even when its timestamp is unreadable, and calls it pinned', () => {
    // The pinned check runs before the timestamp is parsed, so an unparseable date can
    // never demote a snapshot the user explicitly asked to keep forever.
    const records = [
      makeRecord({ id: 'pinned-garbage', seq: 1, createdAt: 'whenever', pinned: true }),
      makeRecord({ id: 'labelled-garbage', seq: 2, createdAt: '???', label: 'keeper' }),
      makeRecord({ id: 'current', seq: 3, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention());

    expect(result.drop).toEqual([]);
    expect(result.reasons['pinned-garbage']).toBe('pinned');
    expect(result.reasons['labelled-garbage']).toBe('named "keeper"');
    expectWellFormed(result, records);
  });

  it('keeps a snapshot whose createdAt cannot be parsed and says so in the reason', () => {
    const records = [
      makeRecord({ id: 'garbage', seq: 1, createdAt: 'not-a-timestamp' }),
      makeRecord({ id: 'empty', seq: 2, createdAt: '' }),
      makeRecord({ id: 'current', seq: 3, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention());

    expect(result.drop).toEqual([]);
    expect(result.reasons['garbage']).toBe('timestamp could not be read');
    expect(result.reasons['empty']).toBe('timestamp could not be read');
    expectWellFormed(result, records);
  });

  it('keeps a snapshot dated in the future rather than treating clock skew as age', () => {
    const records = [
      makeRecord({ id: 'current', seq: 1, ageMs: 0 }),
      makeRecord({ id: 'from-the-future', seq: 2, ageMs: -3 * DAY }),
    ];

    const result = plan(records, retention());

    expect(result.drop).toEqual([]);
    expectWellFormed(result, records);
  });

  it('trims oldest-first once maxSnapshots is exceeded', () => {
    const records = Array.from({ length: 10 }, (_, i) =>
      makeRecord({ id: `s${i}`, seq: i + 1, ageMs: (10 - i) * MINUTE }),
    );

    const result = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 4 }));

    expect(result.keep).toHaveLength(4);
    expect([...result.drop].sort()).toEqual(['s0', 's1', 's2', 's3', 's4', 's5'].sort());
    expect([...result.keep].sort()).toEqual(['s6', 's7', 's8', 's9'].sort());
    for (const id of result.drop) {
      expect(result.reasons[id]).toBe('over the 4 snapshot limit');
    }
    expectWellFormed(result, records);
  });

  it('never evicts a pinned, labelled, latest or latest-healthy snapshot to satisfy maxSnapshots', () => {
    const records = [
      makeRecord({ id: 's0', seq: 1, ageMs: 10 * MINUTE }),
      makeRecord({ id: 'pinned', seq: 2, ageMs: 9 * MINUTE, pinned: true }),
      makeRecord({ id: 'labelled', seq: 3, ageMs: 8 * MINUTE, label: 'keeper' }),
      makeRecord({ id: 'healthy', seq: 4, ageMs: 7 * MINUTE, health: 'healthy' }),
      makeRecord({ id: 's4', seq: 5, ageMs: 6 * MINUTE }),
      makeRecord({ id: 's5', seq: 6, ageMs: 5 * MINUTE }),
      makeRecord({ id: 's6', seq: 7, ageMs: 4 * MINUTE }),
      makeRecord({ id: 's7', seq: 8, ageMs: 3 * MINUTE }),
      makeRecord({ id: 's8', seq: 9, ageMs: 2 * MINUTE }),
      makeRecord({ id: 'latest', seq: 10, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 5 }));

    expect([...result.keep].sort()).toEqual(
      ['pinned', 'labelled', 'healthy', 's8', 'latest'].sort(),
    );
    expect([...result.drop].sort()).toEqual(['s0', 's4', 's5', 's6', 's7'].sort());
    expectWellFormed(result, records);
  });

  it('never evicts the latest healthy snapshot even when it is the oldest eviction candidate', () => {
    // Eviction walks oldest-first, so putting the last known-good snapshot at the very
    // front of that walk is the case most likely to lose it.
    const records = [
      makeRecord({ id: 'healthy', seq: 1, ageMs: 20 * MINUTE, health: 'healthy' }),
      ...Array.from({ length: 8 }, (_, i) =>
        makeRecord({ id: `s${i}`, seq: i + 2, ageMs: (19 - i) * MINUTE, health: 'broken' }),
      ),
    ];

    const result = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 2 }));

    expect([...result.keep].sort()).toEqual(['healthy', 's7'].sort());
    expect(result.reasons['healthy']).toBe('most recent snapshot that passed the health check');
    expect(result.reasons['s7']).toBe('most recent snapshot');
    expectWellFormed(result, records);
  });

  it('leaves the plan untouched when the keep set is already within maxSnapshots', () => {
    const records = timeline([
      { id: 'a', ageMs: 3 * MINUTE },
      { id: 'b', ageMs: 2 * MINUTE },
      { id: 'c', ageMs: 1 * MINUTE },
    ]);

    const atLimit = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 3 }));
    const underLimit = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 99 }));

    expect(atLimit.drop).toEqual([]);
    expect(atLimit).toEqual(underLimit);
    expectWellFormed(atLimit, records);
  });

  it('lets protected snapshots overshoot maxSnapshots rather than deleting them', () => {
    const records = [
      makeRecord({ id: 'pinned', seq: 1, ageMs: 5 * MINUTE, pinned: true }),
      makeRecord({ id: 'labelled', seq: 2, ageMs: 4 * MINUTE, label: 'keeper' }),
      makeRecord({ id: 'expendable', seq: 3, ageMs: 3 * MINUTE }),
      makeRecord({ id: 'latest', seq: 4, ageMs: 1 * MINUTE }),
    ];

    const result = plan(records, retention({ keepAllWithinMinutes: 60, maxSnapshots: 1 }));

    // The ceiling is a target, not a licence to destroy protected history.
    expect([...result.keep].sort()).toEqual(['labelled', 'latest', 'pinned'].sort());
    expect(result.drop).toEqual(['expendable']);
    expectWellFormed(result, records);
  });

  it('gives every dropped snapshot a reason across a mixed-age corpus', () => {
    const entries: { id: string; ageMs: number }[] = [];
    for (let i = 0; i < 200; i += 1) {
      entries.push({ id: `mixed-${i}`, ageMs: i * 3 * HOUR + i * 7 * MINUTE });
    }
    const records = timeline(entries);

    const result = plan(records, retention());

    expect(result.drop.length).toBeGreaterThan(0);
    expect(Object.keys(result.reasons).sort()).toEqual(records.map((record) => record.id).sort());
    expectWellFormed(result, records);
  });

  it('produces an identical plan for the same input and the same now', () => {
    const records = timeline(
      Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, ageMs: i * 41 * MINUTE })),
    );
    const config = retention({ maxSnapshots: 40 });

    expect(plan(records, config)).toEqual(plan(records, config));
  });

  it('produces the same plan regardless of the order the records arrive in', () => {
    const records = timeline(
      Array.from({ length: 120 }, (_, i) => ({ id: `s${i}`, ageMs: i * 41 * MINUTE })),
    );
    const config = retention({ maxSnapshots: 40 });

    // Deterministic reshuffle (fixed LCG) — no Math.random, so a failure reproduces.
    const shuffled = [...records];
    let seed = 20_240_115;
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      const j = seed % (i + 1);
      const a = shuffled[i]!;
      const b = shuffled[j]!;
      shuffled[i] = b;
      shuffled[j] = a;
    }
    expect(shuffled.map((record) => record.id)).not.toEqual(records.map((record) => record.id));

    expect(plan(shuffled, config)).toEqual(plan(records, config));
  });

  it('does not mutate the records it is given', () => {
    const records = timeline([
      { id: 'a', ageMs: 1 * MINUTE },
      { id: 'b', ageMs: 400 * DAY },
    ]);
    const before = structuredClone(records);

    plan(records, retention());

    expect(records).toEqual(before);
  });
});

const tempDirs: string[] = [];

afterEach(async () => {
  const dirs = tempDirs.splice(0, tempDirs.length);
  await Promise.all(dirs.map((dir) => fs.rm(dir, { recursive: true, force: true, maxRetries: 5 })));
});

interface Repo {
  root: string;
  store: ObjectStore;
  index: SnapshotIndex;
  logLines: string[];
  logger: Logger;
}

async function openRepo(): Promise<Repo> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-prune-'));
  tempDirs.push(root);
  const paths = repoPaths(root);
  const store = new ObjectStore(paths.objects, paths.tmp);
  const index = await SnapshotIndex.open(paths.index, paths.tmp, silentLogger);
  const logLines: string[] = [];
  const logger = createLogger({
    level: 'debug',
    write: (line) => {
      logLines.push(line);
    },
  });
  return { root, store, index, logLines, logger };
}

interface AddedSnapshot {
  record: SnapshotRecord;
  treeHash: string;
  blobs: Map<string, string>;
}

async function addSnapshot(
  repo: Repo,
  id: string,
  seq: number,
  files: Record<string, string>,
): Promise<AddedSnapshot> {
  const entries: FileEntry[] = [];
  const blobs = new Map<string, string>();
  for (const [file, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const put = await repo.store.put(data);
    entries.push({ path: file, hash: put.hash, size: data.byteLength, executable: false });
    blobs.set(file, put.hash);
  }
  const tree: Tree = { v: 1, files: entries };
  const treePut = await repo.store.putJson(tree);
  const record = makeRecord({ id, seq, ageMs: 0, treeHash: treePut.hash });
  await repo.index.add(record);
  return { record, treeHash: treePut.hash, blobs };
}

function dropPlan(drop: readonly string[], keep: readonly string[]): PrunePlan {
  return {
    keep: [...keep],
    drop: [...drop],
    reasons: Object.fromEntries(drop.map((id) => [id, 'older than the retention window'])),
  };
}

async function sizeOnDisk(store: ObjectStore, hash: string): Promise<number> {
  const stat = await fs.stat(store.objectPath(hash));
  return stat.size;
}

async function allHashes(store: ObjectStore): Promise<string[]> {
  const hashes: string[] = [];
  for await (const hash of store.listHashes()) hashes.push(hash);
  return hashes;
}

describe('applyPrune', () => {
  it('removes the dropped snapshots from the index', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    expect(result.droppedSnapshots).toBe(1);
    expect(repo.index.get('aaa')).toBeNull();
    expect(repo.index.get('bbb')).not.toBeNull();
    expect(repo.index.size).toBe(1);
  });

  it('collects only the objects nothing references any more', async () => {
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, {
      'shared.txt': 'shared between both snapshots',
      'only-a.txt': 'unique to the snapshot being dropped',
    });
    const b = await addSnapshot(repo, 'bbb', 2, {
      'shared.txt': 'shared between both snapshots',
      'only-b.txt': 'unique to the snapshot that survives',
    });
    const sharedHash = a.blobs.get('shared.txt')!;
    const onlyAHash = a.blobs.get('only-a.txt')!;
    const onlyBHash = b.blobs.get('only-b.txt')!;
    expect(sharedHash).toBe(b.blobs.get('shared.txt'));

    const expectedBytes =
      (await sizeOnDisk(repo.store, a.treeHash)) + (await sizeOnDisk(repo.store, onlyAHash));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    expect(result).toEqual({
      droppedSnapshots: 1,
      deletedObjects: 2,
      reclaimedBytes: expectedBytes,
    });
    await expect(repo.store.has(a.treeHash)).resolves.toBe(false);
    await expect(repo.store.has(onlyAHash)).resolves.toBe(false);
    // A blob still referenced by a surviving snapshot must be untouched.
    await expect(repo.store.has(sharedHash)).resolves.toBe(true);
    await expect(repo.store.has(onlyBHash)).resolves.toBe(true);
    await expect(repo.store.has(b.treeHash)).resolves.toBe(true);
  });

  it('keeps every object of a snapshot that survives, even when its blobs are unique', async () => {
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'only in a' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'only in b' });
    const c = await addSnapshot(repo, 'ccc', 3, { 'c.txt': 'only in c' });

    await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['bbb'], ['aaa', 'ccc']),
      logger: repo.logger,
    });

    const survivors = new Set(await allHashes(repo.store));
    expect(survivors.has(a.treeHash)).toBe(true);
    expect(survivors.has(a.blobs.get('a.txt')!)).toBe(true);
    expect(survivors.has(c.treeHash)).toBe(true);
    expect(survivors.has(c.blobs.get('c.txt')!)).toBe(true);
    expect(survivors.has(b.treeHash)).toBe(false);
    expect(survivors.has(b.blobs.get('b.txt')!)).toBe(false);
  });

  it('sweeps unreachable objects left behind by earlier runs, not just the dropped snapshot', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    // An object no snapshot has ever referenced: a crashed snapshot, or a store an
    // older version left half-written.
    const orphan = await repo.store.put(Buffer.from('orphaned by an interrupted snapshot', 'utf8'));
    expect(orphan.stored).toBe(true);

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    await expect(repo.store.has(orphan.hash)).resolves.toBe(false);
    // tree of aaa, blob of aaa, and the orphan.
    expect(result.deletedObjects).toBe(3);
  });

  it('abandons the object sweep entirely when a surviving tree object is missing', async () => {
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const orphan = await repo.store.put(Buffer.from('definitely unreachable', 'utf8'));
    const before = new Set(await allHashes(repo.store));

    // The surviving snapshot's tree is gone, so the reachable set cannot be computed.
    await fs.rm(repo.store.objectPath(b.treeHash));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
    expect(result.droppedSnapshots).toBe(1);

    // Nothing at all was swept: not the dropped snapshot's now-unreachable objects,
    // and certainly not an object that only *looks* unreachable.
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(a.blobs.get('a.txt')!)).resolves.toBe(true);
    await expect(repo.store.has(orphan.hash)).resolves.toBe(true);
    const after = new Set(await allHashes(repo.store));
    before.delete(b.treeHash);
    expect([...after].sort()).toEqual([...before].sort());

    expect(
      repo.logLines.some((line) => line.includes('bbb') && /object cleanup/i.test(line)),
      'the user must be told the cleanup was skipped',
    ).toBe(true);
  });

  it('abandons the object sweep when the unreadable tree is not the last survivor examined', async () => {
    // The mark phase stops at the first unreadable tree. If it swept anyway, every
    // object belonging to a survivor it had not reached yet would look unreachable and
    // be destroyed. This is that exact scenario: the casualty would be `ddd`.
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const c = await addSnapshot(repo, 'ccc', 3, { 'c.txt': 'gamma' });
    const d = await addSnapshot(repo, 'ddd', 4, { 'd.txt': 'delta' });
    const before = new Set(await allHashes(repo.store));

    await fs.rm(repo.store.objectPath(c.treeHash));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb', 'ccc', 'ddd']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
    // The survivor beyond the failure point still has all of its objects.
    await expect(repo.store.has(d.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(d.blobs.get('d.txt')!)).resolves.toBe(true);
    await expect(repo.store.has(b.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
    const after = new Set(await allHashes(repo.store));
    before.delete(c.treeHash);
    expect([...after].sort()).toEqual([...before].sort());
  });

  it('abandons the object sweep when a surviving tree parses but carries no file list', async () => {
    // Readable, hash-verified, valid JSON — and still not a tree. The reachable set
    // would silently be missing that snapshot's blobs, so the sweep must not run.
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const notATree = await repo.store.putJson({ v: 1 });
    await repo.index.add(makeRecord({ id: 'ccc', seq: 3, ageMs: 0, treeHash: notATree.hash }));
    const before = await allHashes(repo.store);

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb', 'ccc']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
    expect(await allHashes(repo.store)).toEqual(before);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(b.blobs.get('b.txt')!)).resolves.toBe(true);
  });

  it('abandons the object sweep when a surviving tree object is corrupt rather than missing', async () => {
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const countBefore = (await allHashes(repo.store)).length;

    // Valid encoding marker, wrong payload: this fails the integrity check inside
    // ObjectStore.get rather than surfacing as ENOENT.
    await fs.writeFile(repo.store.objectPath(b.treeHash), Buffer.from([0x00, 0x7b]));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(0);
    expect(result.reclaimedBytes).toBe(0);
    expect((await allHashes(repo.store)).length).toBe(countBefore);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(a.blobs.get('a.txt')!)).resolves.toBe(true);
  });

  it('does no work at all when the drop list is empty', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const orphan = await repo.store.put(Buffer.from('unreferenced but not swept', 'utf8'));
    const before = await allHashes(repo.store);

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: { keep: ['aaa'], drop: [], reasons: {} },
      logger: repo.logger,
    });

    expect(result).toEqual({ droppedSnapshots: 0, deletedObjects: 0, reclaimedBytes: 0 });
    // An empty plan is not an invitation to garbage-collect.
    await expect(repo.store.has(orphan.hash)).resolves.toBe(true);
    expect(await allHashes(repo.store)).toEqual(before);
    expect(repo.index.size).toBe(1);
  });

  it('drops every snapshot and collects everything when the plan keeps nothing', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa', 'bbb'], []),
      logger: repo.logger,
    });

    expect(repo.index.size).toBe(0);
    expect(result.droppedSnapshots).toBe(2);
    expect(result.deletedObjects).toBe(4);
    expect(await allHashes(repo.store)).toEqual([]);
  });

  it('tolerates a drop list naming a snapshot the index does not have', async () => {
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['not-a-real-id'], ['aaa']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(0);
    expect(repo.index.size).toBe(1);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
    await expect(repo.store.has(a.blobs.get('a.txt')!)).resolves.toBe(true);
  });

  it('keeps a tree object that two snapshots share when only one of them is dropped', async () => {
    // Identical file sets produce an identical tree, and the store holds it once.
    // Dropping one of the two must not take the object the other still points at.
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'same.txt': 'identical content' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'same.txt': 'identical content' });
    expect(b.treeHash).toBe(a.treeHash);
    const before = await allHashes(repo.store);

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    expect(result).toEqual({ droppedSnapshots: 1, deletedObjects: 0, reclaimedBytes: 0 });
    expect(await allHashes(repo.store)).toEqual(before);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(true);
  });

  it('deletes nothing further when the same plan is applied a second time', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const pruning = dropPlan(['aaa'], ['bbb']);

    const first = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: pruning,
      logger: repo.logger,
    });
    const afterFirst = await allHashes(repo.store);

    const second = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: pruning,
      logger: repo.logger,
    });

    expect(first.deletedObjects).toBe(2);
    expect(second.deletedObjects).toBe(0);
    expect(second.reclaimedBytes).toBe(0);
    expect(await allHashes(repo.store)).toEqual(afterFirst);
    expect(repo.index.size).toBe(1);
  });

  it('still collects unreachable objects when a surviving tree points at a blob that is gone', async () => {
    // A snapshot can be incomplete (an interrupted write, a hand-edited store). That
    // is a job for `doctor`; it must not stop prune reclaiming space, because the
    // reachable set is still complete with respect to what the trees say.
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const b = await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const ghost: Tree = {
      v: 1,
      files: [{ path: 'ghost.txt', hash: 'a'.repeat(64), size: 3, executable: false }],
    };
    const ghostTree = await repo.store.putJson(ghost);
    await repo.index.add(makeRecord({ id: 'ccc', seq: 3, ageMs: 0, treeHash: ghostTree.hash }));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb', 'ccc']),
      logger: repo.logger,
    });

    expect(result.deletedObjects).toBe(2);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(false);
    await expect(repo.store.has(a.blobs.get('a.txt')!)).resolves.toBe(false);
    await expect(repo.store.has(ghostTree.hash)).resolves.toBe(true);
    await expect(repo.store.has(b.blobs.get('b.txt')!)).resolves.toBe(true);
  });

  it('cannot be made to touch anything outside the object directory by a hostile tree entry', async () => {
    // The index and the objects it names are plain files a user (or a malicious
    // snapshot import) can edit. Path-shaped hashes in a tree must stay inert data.
    const repo = await openRepo();
    const a = await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    const sentinel = path.join(repo.root, 'do-not-delete.txt');
    await fs.writeFile(sentinel, 'still here', 'utf8');
    const hostile: Tree = {
      v: 1,
      files: [
        { path: 'escape', hash: '../../../../do-not-delete.txt', size: 0, executable: false },
        { path: 'absolute', hash: repo.root, size: 0, executable: false },
        { path: 'empty', hash: '', size: 0, executable: false },
      ],
    };
    const hostileTree = await repo.store.putJson(hostile);
    await repo.index.add(makeRecord({ id: 'bbb', seq: 2, ageMs: 0, treeHash: hostileTree.hash }));

    const result = await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: dropPlan(['aaa'], ['bbb']),
      logger: repo.logger,
    });

    // Only aaa's own two objects went, and the file outside the store is untouched.
    expect(result.deletedObjects).toBe(2);
    await expect(fs.readFile(sentinel, 'utf8')).resolves.toBe('still here');
    await expect(repo.store.has(hostileTree.hash)).resolves.toBe(true);
    await expect(repo.store.has(a.treeHash)).resolves.toBe(false);
  });

  it('stops instead of sweeping when the caller aborts', async () => {
    const repo = await openRepo();
    await addSnapshot(repo, 'aaa', 1, { 'a.txt': 'alpha' });
    await addSnapshot(repo, 'bbb', 2, { 'b.txt': 'beta' });
    const before = await allHashes(repo.store);
    const controller = new AbortController();
    controller.abort();

    await expect(
      applyPrune({
        index: repo.index,
        store: repo.store,
        plan: dropPlan(['aaa'], ['bbb']),
        logger: repo.logger,
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    expect(await allHashes(repo.store)).toEqual(before);
  });
});

describe('planPrune and applyPrune together', () => {
  it('keeps exactly the snapshots the plan named and no others', async () => {
    const repo = await openRepo();
    const added: AddedSnapshot[] = [];
    const specs = [
      { id: 'oldest', ageMs: 400 * DAY },
      { id: 'old', ageMs: 300 * DAY },
      { id: 'middle', ageMs: 3 * DAY },
      { id: 'newest', ageMs: 1 * MINUTE },
    ];
    for (const [i, spec] of specs.entries()) {
      const snapshot = await addSnapshot(repo, spec.id, i + 1, { [`${spec.id}.txt`]: spec.id });
      // Re-add with the age the plan should see; the store already holds the objects.
      await repo.index.add(
        makeRecord({
          id: spec.id,
          seq: i + 1,
          ageMs: spec.ageMs,
          treeHash: snapshot.treeHash,
        }),
      );
      added.push(snapshot);
    }

    const pruning = plan(repo.index.list(), retention());
    expect(pruning.drop.sort()).toEqual(['old', 'oldest']);

    await applyPrune({
      index: repo.index,
      store: repo.store,
      plan: pruning,
      logger: repo.logger,
    });

    expect(
      repo.index
        .list()
        .map((record) => record.id)
        .sort(),
    ).toEqual(['middle', 'newest']);
    const remaining = new Set(await allHashes(repo.store));
    for (const snapshot of added.slice(0, 2)) {
      expect(remaining.has(snapshot.treeHash)).toBe(false);
    }
    for (const snapshot of added.slice(2)) {
      expect(remaining.has(snapshot.treeHash)).toBe(true);
      expect(remaining.has([...snapshot.blobs.values()][0]!)).toBe(true);
    }
  });
});
