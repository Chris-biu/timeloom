import type * as NodeCrypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MIN_ID_PREFIX, SnapshotIndex, type SnapshotPatch } from '../src/core/store.js';
import { TimeloomError, type TimeloomErrorCode } from '../src/errors.js';
import { createLogger, silentLogger, type Logger } from '../src/logger.js';
import { repoPaths, type RepoPaths } from '../src/paths.js';
import type { HealthResult, HealthStatus, SnapshotRecord, SnapshotTrigger } from '../src/types.js';

/**
 * `allocate()` re-rolls the id when it collides with a live record and widens to 8
 * random bytes if it somehow keeps colliding. Random ids make that path unreachable,
 * so one test pins `randomBytes(4)` to a known value. The control flag defaults to
 * `null`, which passes straight through to the real implementation for every other
 * test in this file (and for `fsx`, which uses `randomUUID`/`createHash`).
 */
const cryptoControl = vi.hoisted(() => ({ fixedFourBytes: null as string | null }));

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeCrypto>();
  const patched = (size: number): Buffer => {
    if (size === 4 && cryptoControl.fixedFourBytes !== null) {
      return Buffer.from(cryptoControl.fixedFourBytes, 'hex');
    }
    return (actual.randomBytes as (n: number) => Buffer)(size);
  };
  return {
    ...actual,
    randomBytes: patched as unknown as typeof actual.randomBytes,
  };
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface RecordInit {
  id: string;
  seq: number;
  label?: string | null;
  pinned?: boolean;
  health?: HealthResult | null;
  createdAt?: string;
  trigger?: SnapshotTrigger;
  parentId?: string | null;
}

function makeRecord(init: RecordInit): SnapshotRecord {
  return {
    id: init.id,
    seq: init.seq,
    createdAt: init.createdAt ?? `2024-01-01T00:00:${String(init.seq % 60).padStart(2, '0')}.000Z`,
    treeHash: `tree-${init.id}`,
    parentId: init.parentId ?? null,
    fileCount: 3,
    totalBytes: 4096,
    trigger: init.trigger ?? 'manual',
    label: init.label ?? null,
    pinned: init.pinned ?? false,
    summary: {
      counts: { added: 1, modified: 2, deleted: 0 },
      samplePaths: ['src/app.ts'],
      scope: 'src',
      kind: 'logic',
    },
    health: init.health ?? null,
  };
}

function makeHealth(status: HealthStatus): HealthResult {
  return {
    status,
    command: 'npm run build',
    exitCode: status === 'healthy' ? 0 : 1,
    durationMs: 42,
    checkedAt: '2024-01-01T00:00:00.000Z',
    outputTail: status === 'healthy' ? '' : 'error TS2322',
  };
}

function addLine(record: SnapshotRecord): string {
  return JSON.stringify({ t: 'add', s: record });
}

/** Whitespace padding around a corrupt line, built rather than typed so it stays visible. */
const PAD = ' '.repeat(2);

/** Capture log output so warnings about corruption can be asserted on. */
function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    logger: createLogger({
      level: 'debug',
      write: (line) => {
        lines.push(line);
      },
    }),
    lines,
  };
}

function failureOf(fn: () => unknown): TimeloomError {
  try {
    fn();
  } catch (error) {
    if (error instanceof TimeloomError) return error;
    throw error;
  }
  throw new Error('expected a TimeloomError, but the call returned normally');
}

function expectCode(fn: () => unknown, code: TimeloomErrorCode): TimeloomError {
  const error = failureOf(fn);
  expect(error.code).toBe(code);
  return error;
}

// ---------------------------------------------------------------------------
// Per-test scratch repository
// ---------------------------------------------------------------------------

let root: string;
let paths: RepoPaths;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-store-'));
  paths = repoPaths(root);
});

afterEach(async () => {
  cryptoControl.fixedFourBytes = null;
  await fs.rm(root, { recursive: true, force: true });
});

function openIndex(logger: Logger = silentLogger): Promise<SnapshotIndex> {
  return SnapshotIndex.open(paths.index, paths.tmp, logger);
}

/** Write index.jsonl by hand, as a crashed process or a hand-editing user would leave it. */
async function writeRawLog(lines: readonly string[]): Promise<void> {
  await fs.mkdir(path.dirname(paths.index), { recursive: true });
  await fs.writeFile(paths.index, lines.length === 0 ? '' : `${lines.join('\n')}\n`, 'utf8');
}

async function appendRaw(text: string): Promise<void> {
  await fs.mkdir(path.dirname(paths.index), { recursive: true });
  await fs.appendFile(paths.index, text, 'utf8');
}

async function readLogLines(): Promise<string[]> {
  const raw = await fs.readFile(paths.index, 'utf8');
  return raw.split('\n').filter((line) => line.trim().length > 0);
}

async function seedRecords(count: number, startSeq = 1): Promise<SnapshotRecord[]> {
  const index = await openIndex();
  const created: SnapshotRecord[] = [];
  for (let i = 0; i < count; i += 1) {
    const seq = startSeq + i;
    const record = makeRecord({ id: `id${String(seq).padStart(5, '0')}`, seq });
    created.push(await index.add(record));
  }
  return created;
}

// ---------------------------------------------------------------------------

describe('SnapshotIndex round-trip', () => {
  it('returns an added record from get() and list() with its fields byte-identical', async () => {
    const index = await openIndex();
    const record = makeRecord({ id: 'aa11bb22', seq: 1, label: 'first', pinned: true });

    const returned = await index.add(record);

    expect(returned).toEqual(record);
    expect(index.get('aa11bb22')).toEqual(record);
    expect(index.list()).toEqual([record]);
    expect(index.size).toBe(1);
  });

  it('reports get() as null for an id that was never added', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aa11bb22', seq: 1 }));

    expect(index.get('nope1234')).toBeNull();
  });

  it('orders list() by seq ascending regardless of the order records were added in', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'cccc0003', seq: 30 }));
    await index.add(makeRecord({ id: 'aaaa0001', seq: 10 }));
    await index.add(makeRecord({ id: 'dddd0004', seq: 40 }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 20 }));

    expect(index.list().map((record) => record.seq)).toEqual([10, 20, 30, 40]);
  });

  it('reports latest() as the record with the highest seq, not the last one written', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'high0009', seq: 9 }));
    await index.add(makeRecord({ id: 'low00001', seq: 1 }));

    expect(index.latest()?.id).toBe('high0009');
  });

  it('reports latest() as null and size 0 for a store that has never been written', async () => {
    const index = await openIndex();

    expect(index.latest()).toBeNull();
    expect(index.lastHealthy()).toBeNull();
    expect(index.list()).toEqual([]);
    expect(index.size).toBe(0);
  });

  it('opens cleanly when neither the index file nor its directory exists', async () => {
    await expect(openIndex()).resolves.toBeInstanceOf(SnapshotIndex);
    await expect(fs.access(paths.index)).rejects.toThrow();
  });
});

describe('SnapshotIndex durability across reopen', () => {
  it('replays a reopened index to exactly the state the writer left behind', async () => {
    const index = await openIndex();
    const records = [
      makeRecord({ id: 'aaaa0001', seq: 1, label: 'start', health: makeHealth('healthy') }),
      makeRecord({ id: 'bbbb0002', seq: 2, pinned: true }),
      makeRecord({ id: 'cccc0003', seq: 3, trigger: 'watch', parentId: 'bbbb0002' }),
    ];
    for (const record of records) await index.add(record);
    const before = index.list();

    const reopened = await openIndex();

    expect(reopened.list()).toEqual(before);
    expect(reopened.size).toBe(3);
    expect(reopened.get('bbbb0002')).toEqual(records[1]);
  });

  it('applies update() as a partial patch, leaving untouched fields alone', async () => {
    const index = await openIndex();
    const original = makeRecord({ id: 'aaaa0001', seq: 1, label: 'old', pinned: false });
    await index.add(original);

    const updated = await index.update('aaaa0001', { label: 'renamed' });

    expect(updated.label).toBe('renamed');
    expect(updated.pinned).toBe(false);
    expect(updated.treeHash).toBe(original.treeHash);
    expect(updated.seq).toBe(1);
    expect(index.get('aaaa0001')).toEqual(updated);
  });

  it('survives a reopen with every patched field, including ones patched to null', async () => {
    const index = await openIndex();
    await index.add(
      makeRecord({ id: 'aaaa0001', seq: 1, label: 'old', health: makeHealth('broken') }),
    );

    await index.update('aaaa0001', { label: null, pinned: true, health: makeHealth('healthy') });
    const expected = index.get('aaaa0001');

    const reopened = await openIndex();
    const replayed = reopened.get('aaaa0001');

    expect(replayed).toEqual(expected);
    expect(replayed?.label).toBeNull();
    expect(replayed?.pinned).toBe(true);
    expect(replayed?.health?.status).toBe('healthy');
  });

  it('replays a sequence of updates so the last write to each field wins', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await index.update('aaaa0001', { label: 'one' });
    await index.update('aaaa0001', { pinned: true });
    await index.update('aaaa0001', { label: 'two' });

    const reopened = await openIndex();
    expect(reopened.get('aaaa0001')?.label).toBe('two');
    expect(reopened.get('aaaa0001')?.pinned).toBe(true);
  });

  it('leaves a record untouched when update() is given an empty patch', async () => {
    const index = await openIndex();
    const original = makeRecord({ id: 'aaaa0001', seq: 1, label: 'kept', pinned: true });
    await index.add(original);

    const patch: SnapshotPatch = {};
    await index.update('aaaa0001', patch);

    expect((await openIndex()).get('aaaa0001')).toEqual(original);
  });

  it('raises SNAPSHOT_NOT_FOUND rather than creating a phantom record when update() targets an unknown id', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await expect(index.update('deadbeef', { label: 'x' })).rejects.toMatchObject({
      code: 'SNAPSHOT_NOT_FOUND',
    });
    expect(index.size).toBe(1);
    expect((await openIndex()).get('deadbeef')).toBeNull();
  });

  it('makes remove() permanent across a reopen while leaving the other records intact', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2 }));
    await index.add(makeRecord({ id: 'cccc0003', seq: 3 }));

    await index.remove(['aaaa0001', 'cccc0003']);

    expect(index.list().map((r) => r.id)).toEqual(['bbbb0002']);
    const reopened = await openIndex();
    expect(reopened.list().map((r) => r.id)).toEqual(['bbbb0002']);
    expect(reopened.get('aaaa0001')).toBeNull();
  });

  it('treats remove() of an unknown id as a no-op instead of throwing', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await expect(index.remove(['not-here'])).resolves.toBeUndefined();

    expect((await openIndex()).list().map((r) => r.id)).toEqual(['aaaa0001']);
  });

  it('writes nothing at all when remove() is given an empty id list', async () => {
    const index = await openIndex();

    await index.remove([]);

    await expect(fs.access(paths.index)).rejects.toThrow();
  });

  it('replays a record that was removed and then re-added under the same id', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1, label: 'v1' }));
    await index.remove(['aaaa0001']);
    await index.add(makeRecord({ id: 'aaaa0001', seq: 2, label: 'v2' }));

    const reopened = await openIndex();
    expect(reopened.size).toBe(1);
    expect(reopened.get('aaaa0001')?.label).toBe('v2');
    expect(reopened.get('aaaa0001')?.seq).toBe(2);
  });
});

describe('SnapshotIndex crash resilience', () => {
  it('keeps every earlier record when the final line was torn off by a crash', async () => {
    const index = await openIndex();
    const kept = [
      makeRecord({ id: 'aaaa0001', seq: 1 }),
      makeRecord({ id: 'bbbb0002', seq: 2 }),
      makeRecord({ id: 'cccc0003', seq: 3 }),
    ];
    for (const record of kept) await index.add(record);

    // A power loss mid-append: a prefix of the next event, no trailing newline.
    await appendRaw('{"t":"add","s":{"id":"dddd0004","seq":4,"createdAt":"2024-01');

    const { logger, lines } = recordingLogger();
    const reopened = await openIndex(logger);

    expect(reopened.list()).toEqual(kept);
    expect(reopened.get('dddd0004')).toBeNull();
    expect(lines.join('\n')).toContain('Skipped 1 unreadable line');
  });

  it('keeps the records on both sides of a garbage line in the middle of the log', async () => {
    const first = makeRecord({ id: 'aaaa0001', seq: 1 });
    const last = makeRecord({ id: 'cccc0003', seq: 3 });
    await writeRawLog([
      addLine(first),
      PAD + 'garbage from a half-flushed page' + PAD,
      addLine(last),
    ]);

    const { logger, lines } = recordingLogger();
    const index = await openIndex(logger);

    expect(index.list()).toEqual([first, last]);
    expect(lines.join('\n')).toContain('Skipped 1 unreadable line');
  });

  it('ignores blank and whitespace-only lines without counting them as corruption', async () => {
    const record = makeRecord({ id: 'aaaa0001', seq: 1 });
    await writeRawLog(['', addLine(record), '   ', '\t']);

    const { logger, lines } = recordingLogger();
    const index = await openIndex(logger);

    expect(index.list()).toEqual([record]);
    expect(lines.join('\n')).not.toContain('unreadable');
  });

  it('keeps working after a reopen that had to skip corruption', async () => {
    const first = makeRecord({ id: 'aaaa0001', seq: 1 });
    await writeRawLog([addLine(first), 'this is not json']);

    const index = await openIndex();
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2 }));

    const reopened = await openIndex();
    expect(reopened.list().map((r) => r.id)).toEqual(['aaaa0001', 'bbbb0002']);
  });

  // BUG: a torn final line has no trailing newline, and `appendEvents` writes its
  // payload without first checking for one. The next event is therefore glued onto
  // the torn fragment, producing a single unparseable line — so the *new* snapshot
  // is silently lost too, on top of the torn one. The class doc promises that "a
  // torn final line of a log costs one snapshot"; here it costs two, and the second
  // is one the user was just told had been taken. Expected: after appending a torn
  // fragment and then adding `dddd0004`, a reopen finds aaaa0001..cccc0003 *and*
  // dddd0004 (4 records). Actual: dddd0004 is missing (3 records). Fix: on the first
  // append after open (or whenever the file does not end in "\n"), prefix the
  // payload with a newline so the torn fragment stays confined to its own line.
  it('does not lose the next snapshot written after a torn final line', async () => {
    const index = await openIndex();
    for (const record of [
      makeRecord({ id: 'aaaa0001', seq: 1 }),
      makeRecord({ id: 'bbbb0002', seq: 2 }),
      makeRecord({ id: 'cccc0003', seq: 3 }),
    ]) {
      await index.add(record);
    }
    await appendRaw('{"t":"add","s":{"id":"torntorn","seq":4,"created');

    const survivor = await openIndex();
    await survivor.add(makeRecord({ id: 'dddd0004', seq: 4 }));

    const reopened = await openIndex();
    expect(reopened.list().map((r) => r.id)).toEqual([
      'aaaa0001',
      'bbbb0002',
      'cccc0003',
      'dddd0004',
    ]);
  });

  // BUG: `apply()` switches on `event.t` without checking that the parsed value is an
  // object. `JSON.parse("null")` succeeds and yields `null`, so reading `.t` throws
  // `TypeError: Cannot read properties of null`. The index is a plain text file a user
  // can edit and a crash can half-write, so a single `null` line makes the whole store
  // unopenable — every command fails with a raw TypeError instead of the file being
  // skipped like any other unreadable line. Expected: the line is skipped and the
  // surrounding records replay. Actual: `SnapshotIndex.open` rejects with a TypeError.
  it('skips a line that parses to a bare JSON null instead of crashing the open', async () => {
    const first = makeRecord({ id: 'aaaa0001', seq: 1 });
    const last = makeRecord({ id: 'cccc0003', seq: 3 });
    await writeRawLog([addLine(first), 'null', addLine(last)]);

    const index = await openIndex();

    expect(index.list()).toEqual([first, last]);
  });

  it('ignores lines that parse to a non-object JSON value', async () => {
    const first = makeRecord({ id: 'aaaa0001', seq: 1 });
    const last = makeRecord({ id: 'cccc0003', seq: 3 });
    await writeRawLog([addLine(first), '123', '"a string"', '[1,2,3]', 'true', addLine(last)]);

    const index = await openIndex();

    expect(index.list()).toEqual([first, last]);
  });

  // BUG: a `set` event whose payload is missing (or explicitly null) reaches
  // `applyPatch(existing, undefined)`, which reads `.label` off `undefined` and throws
  // `TypeError: Cannot read properties of undefined`. Same problem as the bare-null
  // line: hand-edited or truncated-then-repaired index files are exactly what this
  // module is built to tolerate, and one bad `set` line takes the whole history with
  // it. Expected: the malformed `set` is ignored and the record keeps its stored
  // values. Actual: `SnapshotIndex.open` rejects with a TypeError.
  it('ignores a set event with no patch payload instead of crashing the open', async () => {
    const record = makeRecord({ id: 'aaaa0001', seq: 1, label: 'kept' });
    await writeRawLog([addLine(record), JSON.stringify({ t: 'set', id: 'aaaa0001' })]);

    const index = await openIndex();

    expect(index.get('aaaa0001')?.label).toBe('kept');
  });

  it('drops a set event that targets an id no longer in the index', async () => {
    const record = makeRecord({ id: 'aaaa0001', seq: 1 });
    await writeRawLog([
      JSON.stringify({ t: 'set', id: 'ghost001', p: { label: 'phantom' } }),
      addLine(record),
      JSON.stringify({ t: 'del', id: 'aaaa0001' }),
      JSON.stringify({ t: 'set', id: 'aaaa0001', p: { label: 'zombie' } }),
    ]);

    const index = await openIndex();

    expect(index.size).toBe(0);
    expect(index.get('ghost001')).toBeNull();
    expect(index.get('aaaa0001')).toBeNull();
  });
});

describe('SnapshotIndex shape checking', () => {
  const valid = makeRecord({ id: 'aaaa0001', seq: 1 });
  const survivor = makeRecord({ id: 'cccc0003', seq: 3 });

  const malformed: readonly [string, unknown][] = [
    ['a missing id', { ...makeRecord({ id: 'x', seq: 2 }), id: undefined }],
    ['an empty id', { ...makeRecord({ id: '', seq: 2 }) }],
    ['a non-string id', { ...makeRecord({ id: 'x', seq: 2 }), id: 42 }],
    ['a non-numeric seq', { ...makeRecord({ id: 'bad00002', seq: 2 }), seq: '2' }],
    ['a missing createdAt', { ...makeRecord({ id: 'bad00002', seq: 2 }), createdAt: undefined }],
    ['a non-string treeHash', { ...makeRecord({ id: 'bad00002', seq: 2 }), treeHash: { evil: 1 } }],
    ['a non-numeric fileCount', { ...makeRecord({ id: 'bad00002', seq: 2 }), fileCount: null }],
    ['a non-numeric totalBytes', { ...makeRecord({ id: 'bad00002', seq: 2 }), totalBytes: '4096' }],
    ['a non-boolean pinned', { ...makeRecord({ id: 'bad00002', seq: 2 }), pinned: 'yes' }],
    ['a null summary', { ...makeRecord({ id: 'bad00002', seq: 2 }), summary: null }],
    ['a non-object summary', { ...makeRecord({ id: 'bad00002', seq: 2 }), summary: 'logic' }],
    ['a record that is not an object', 'just a string'],
    ['a null record', null],
  ];

  it.each(malformed)('skips an add event carrying %s without losing the rest', async (_, bad) => {
    await writeRawLog([addLine(valid), JSON.stringify({ t: 'add', s: bad }), addLine(survivor)]);

    const { logger, lines } = recordingLogger();
    const index = await openIndex(logger);

    expect(index.list()).toEqual([valid, survivor]);
    expect(index.size).toBe(2);
    expect(lines.join('\n')).toContain('is not a valid record');
  });

  it('names the offending line number when it skips an invalid record', async () => {
    await writeRawLog([addLine(valid), JSON.stringify({ t: 'add', s: { id: 'partial' } })]);

    const { logger, lines } = recordingLogger();
    await openIndex(logger);

    expect(lines.join('\n')).toContain('line 2');
  });

  it('does not pollute Object.prototype from a record carrying a __proto__ key', async () => {
    await writeRawLog([
      addLine(valid),
      `{"t":"add","s":{"id":"evil0002","seq":2,"createdAt":"2024-01-01T00:00:02.000Z","treeHash":"t","parentId":null,"fileCount":0,"totalBytes":0,"trigger":"manual","label":null,"pinned":false,"summary":{},"health":null,"__proto__":{"polluted":"yes"}}}`,
    ]);

    const index = await openIndex();

    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
    expect(index.size).toBe(2);
  });

  it('ignores an unknown future event kind so a newer timeloom can share the store', async () => {
    const first = makeRecord({ id: 'aaaa0001', seq: 1 });
    const last = makeRecord({ id: 'cccc0003', seq: 3 });
    await writeRawLog([
      addLine(first),
      '{"t":"future"}',
      '{"t":"squash","from":"aaaa0001","to":"cccc0003"}',
      addLine(last),
    ]);

    const { logger, lines } = recordingLogger();
    const index = await openIndex(logger);

    expect(index.list()).toEqual([first, last]);
    expect(lines.join('\n')).toContain('Ignoring unknown index event');
    // An unknown kind is forward compatibility, not corruption; it must not be
    // reported to the user as an unreadable line.
    expect(lines.join('\n')).not.toContain('unreadable');
  });
});

describe('SnapshotIndex compaction', () => {
  /** 40 adds + 40 sets = 80 events over 40 live records: just under the threshold. */
  async function seedRedundantLog(count: number): Promise<SnapshotRecord[]> {
    const records: SnapshotRecord[] = [];
    const lines: string[] = [];
    for (let seq = 1; seq <= count; seq += 1) {
      const record = makeRecord({ id: `id${String(seq).padStart(5, '0')}`, seq });
      records.push({ ...record, label: `patched-${seq}` });
      lines.push(addLine(record));
    }
    for (let seq = 1; seq <= count; seq += 1) {
      lines.push(
        JSON.stringify({
          t: 'set',
          id: `id${String(seq).padStart(5, '0')}`,
          p: { label: `patched-${seq}` },
        }),
      );
    }
    await writeRawLog(lines);
    return records;
  }

  it('leaves the log alone while redundancy is below the compaction threshold', async () => {
    await seedRedundantLog(40);
    const index = await openIndex();

    await expect(index.compactIfNeeded()).resolves.toBe(false);

    expect(await readLogLines()).toHaveLength(80);
  });

  it('shrinks the log to one line per live record once redundancy trips the threshold', async () => {
    const records = await seedRedundantLog(40);
    const index = await openIndex();
    const before = index.list();
    expect(await readLogLines()).toHaveLength(80);

    // 80 replayed events + 1 delete over 39 live records trips max(64, 39 * 2) = 78.
    await index.remove(['id00040']);

    const lines = await readLogLines();
    expect(lines).toHaveLength(39);
    expect(lines.every((line) => (JSON.parse(line) as { t: string }).t === 'add')).toBe(true);
    // In-memory state is untouched by the rewrite, minus the record just removed.
    expect(index.list()).toEqual(before.filter((r) => r.id !== 'id00040'));
    expect(index.list()).toEqual(records.slice(0, 39));
  });

  it('replays a compacted log to the same state, patches included', async () => {
    await seedRedundantLog(40);
    const index = await openIndex();
    await index.remove(['id00040']);
    const compacted = index.list();

    const reopened = await openIndex();

    expect(reopened.list()).toEqual(compacted);
    expect(reopened.get('id00001')?.label).toBe('patched-1');
    expect(reopened.size).toBe(39);
  });

  it('rewrites the log on demand when compaction is forced below the threshold', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.update('aaaa0001', { label: 'named' });
    await index.update('aaaa0001', { pinned: true });
    expect(await readLogLines()).toHaveLength(3);
    const before = index.list();

    await expect(index.compactIfNeeded(true)).resolves.toBe(true);

    expect(await readLogLines()).toHaveLength(1);
    expect(index.list()).toEqual(before);
    expect((await openIndex()).list()).toEqual(before);
  });

  it('is idempotent: compacting an already-compact log leaves it unchanged', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2 }));

    await index.compact();
    const first = await fs.readFile(paths.index, 'utf8');
    await index.compact();
    const second = await fs.readFile(paths.index, 'utf8');

    expect(second).toBe(first);
    await expect(index.compactIfNeeded()).resolves.toBe(false);
  });

  it('writes an empty log when every record has been removed', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await index.compact();
    await index.remove(['aaaa0001']);
    await index.compact();

    expect(await readLogLines()).toEqual([]);
    expect((await openIndex()).size).toBe(0);
  });

  it('does not leave temporary files behind after compacting', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await index.compact();

    await expect(fs.readdir(paths.tmp)).resolves.toEqual([]);
  });
});

describe('SnapshotIndex.allocate', () => {
  it('never hands out an id that is already in the index', async () => {
    const index = await openIndex();
    const seen = new Set<string>();

    for (let i = 0; i < 120; i += 1) {
      const { id, seq } = index.allocate();
      expect(seen.has(id)).toBe(false);
      expect(index.get(id)).toBeNull();
      seen.add(id);
      await index.add(makeRecord({ id, seq }));
    }

    expect(seen.size).toBe(120);
    expect(index.size).toBe(120);
  });

  it('hands out short url-safe lowercase hex ids', async () => {
    const index = await openIndex();

    const { id } = index.allocate();

    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('widens the id rather than reusing one when the short id keeps colliding', async () => {
    const index = await openIndex();
    cryptoControl.fixedFourBytes = 'deadbeef';
    await index.add(makeRecord({ id: 'deadbeef', seq: 1 }));

    const { id } = index.allocate();

    // Every 4-byte roll collides, so it must fall back to 8 bytes instead of
    // silently returning an id that already names a different snapshot.
    expect(id).not.toBe('deadbeef');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('starts seq at 1 for a brand new store', async () => {
    const index = await openIndex();

    expect(index.allocate().seq).toBe(1);
  });

  it('increases seq monotonically across reopens', async () => {
    const seqs: number[] = [];

    for (let round = 0; round < 4; round += 1) {
      const index = await openIndex();
      const { id, seq } = index.allocate();
      seqs.push(seq);
      await index.add(makeRecord({ id, seq }));
    }

    expect(seqs).toEqual([1, 2, 3, 4]);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    }
  });

  it('keeps allocating above the highest seq after a compaction', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 7 }));
    await index.compact();

    const reopened = await openIndex();

    expect(reopened.allocate().seq).toBe(8);
  });

  it('does not reserve the id it returns until the record is actually added', async () => {
    const index = await openIndex();

    const first = index.allocate();
    const second = index.allocate();

    // Both are unclaimed, so seq is the same; the caller commits by calling add().
    expect(first.seq).toBe(second.seq);
    expect(index.size).toBe(0);
  });
});

describe('SnapshotIndex.resolve', () => {
  const records = {
    one: makeRecord({ id: 'aa11bb22', seq: 1, health: makeHealth('healthy') }),
    two: makeRecord({ id: 'aa11cc33', seq: 2, label: 'before-refactor' }),
    three: makeRecord({ id: 'bb00dd44', seq: 3, health: makeHealth('broken') }),
    four: makeRecord({ id: 'cc99ee55', seq: 7, health: makeHealth('skipped') }),
  } as const;

  async function populated(): Promise<SnapshotIndex> {
    const index = await openIndex();
    for (const record of Object.values(records)) await index.add(record);
    return index;
  }

  it('resolves a full id to its record', async () => {
    const index = await populated();

    expect(index.resolve('aa11cc33')).toEqual(records.two);
  });

  it('resolves a prefix that matches exactly one id', async () => {
    const index = await populated();

    expect(index.resolve('bb0')).toEqual(records.three);
  });

  it('raises AMBIGUOUS_ID with the candidate ids when a prefix matches several snapshots', async () => {
    const index = await populated();

    const error = expectCode(() => index.resolve('aa11'), 'AMBIGUOUS_ID');

    expect(error.message).toContain('matches 2 snapshots');
    expect(error.hint).toContain('aa11bb22');
    expect(error.hint).toContain('aa11cc33');
  });

  it('refuses a prefix shorter than the minimum rather than guessing', async () => {
    const index = await populated();

    const error = expectCode(() => index.resolve('aa'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('too short');
    expect(error.hint).toContain(String(MIN_ID_PREFIX));
  });

  it.each(['latest', 'head', 'last'])('resolves %s to the highest-seq snapshot', async (alias) => {
    const index = await populated();

    expect(index.resolve(alias)).toEqual(records.four);
  });

  it.each(['healthy', 'working', 'last-healthy'])(
    'resolves %s to the newest snapshot that passed its health probe',
    async (alias) => {
      const index = await populated();

      expect(index.resolve(alias)).toEqual(records.one);
    },
  );

  it('resolves ~0 to the latest snapshot', async () => {
    const index = await populated();

    expect(index.resolve('~0')).toEqual(records.four);
  });

  it('resolves ~2 to two snapshots back in creation order', async () => {
    const index = await populated();

    expect(index.resolve('~2')).toEqual(records.two);
  });

  it('resolves head~1 the same way as ~1', async () => {
    const index = await populated();

    expect(index.resolve('head~1')).toEqual(records.three);
    expect(index.resolve('head~1')).toEqual(index.resolve('~1'));
  });

  it('raises SNAPSHOT_NOT_FOUND saying how far back it could have gone for an out-of-range ~N', async () => {
    const index = await populated();

    const error = expectCode(() => index.resolve('~4'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('only 4 snapshots');
    expect(error.message).toContain('cannot go back 4');
  });

  it('resolves #seq to the record with that raw counter value, not that position', async () => {
    const index = await populated();

    expect(index.resolve('#7')).toEqual(records.four);
    expect(index.resolve('#1')).toEqual(records.one);
  });

  it('raises SNAPSHOT_NOT_FOUND for a #seq no record carries', async () => {
    const index = await populated();

    const error = expectCode(() => index.resolve('#4'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('#4');
  });

  it('resolves a user-supplied label', async () => {
    const index = await populated();

    expect(index.resolve('before-refactor')).toEqual(records.two);
  });

  it('prefers a label over an id prefix that would otherwise be ambiguous', async () => {
    const index = await openIndex();
    await index.add(records.one);
    await index.add(records.two);
    await index.add(makeRecord({ id: 'ff00ff00', seq: 5, label: 'aa11' }));

    expect(index.resolve('aa11').id).toBe('ff00ff00');
  });

  it('raises AMBIGUOUS_ID when two snapshots share a label', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1, label: 'good' }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2, label: 'good' }));

    const error = expectCode(() => index.resolve('good'), 'AMBIGUOUS_ID');

    expect(error.message).toContain('2 snapshots are named "good"');
    expect(error.hint).toContain('timeloom list');
  });

  it('raises SNAPSHOT_NOT_FOUND with a hint for a reference that matches nothing', async () => {
    const index = await populated();

    const error = expectCode(() => index.resolve('zzzzzzzz'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('zzzzzzzz');
    expect(error.hint).toContain('timeloom list');
  });

  it.each([
    ['AA11CC33', 'aa11cc33'],
    ['BB0', 'bb00dd44'],
    ['LATEST', 'cc99ee55'],
    ['Head~1', 'bb00dd44'],
    ['Healthy', 'aa11bb22'],
    ['Before-Refactor', 'aa11cc33'],
  ])('resolves %s case-insensitively', async (reference, expectedId) => {
    const index = await populated();

    expect(index.resolve(reference).id).toBe(expectedId);
  });

  it('ignores surrounding whitespace in the reference', async () => {
    const index = await populated();

    expect(index.resolve('  aa11cc33  ')).toEqual(records.two);
    expect(index.resolve('\tlatest\n')).toEqual(records.four);
  });

  it.each(['', '   ', '\n'])(
    'raises SNAPSHOT_NOT_FOUND for the blank reference %j',
    async (blank) => {
      const index = await populated();

      const error = expectCode(() => index.resolve(blank), 'SNAPSHOT_NOT_FOUND');

      expect(error.message).toBe('No snapshot given');
    },
  );

  it('tells a user with no snapshots at all how to take one', async () => {
    const index = await openIndex();

    const error = expectCode(() => index.resolve('latest'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('no snapshots yet');
    expect(error.hint).toContain('timeloom snap');
  });

  it('resolves ids that only exist after a reopen', async () => {
    await populated();

    const reopened = await openIndex();

    expect(reopened.resolve('aa11cc33')).toEqual(records.two);
    expect(reopened.resolve('before-refactor')).toEqual(records.two);
    expect(reopened.resolve('#7')).toEqual(records.four);
  });

  it('stops resolving a reference once its snapshot is removed', async () => {
    const index = await populated();

    await index.remove(['aa11cc33']);

    expectCode(() => index.resolve('aa11cc33'), 'SNAPSHOT_NOT_FOUND');
    expectCode(() => index.resolve('before-refactor'), 'SNAPSHOT_NOT_FOUND');
    expect(index.resolve('aa11')).toEqual(records.one);
  });
});

describe('SnapshotIndex health tracking', () => {
  it('picks the newest healthy snapshot, ignoring broken, timed-out, errored and skipped ones', async () => {
    const index = await openIndex();
    const healthy = makeRecord({ id: 'aaaa0002', seq: 2, health: makeHealth('healthy') });
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1, health: makeHealth('healthy') }));
    await index.add(healthy);
    await index.add(makeRecord({ id: 'aaaa0003', seq: 3, health: makeHealth('broken') }));
    await index.add(makeRecord({ id: 'aaaa0004', seq: 4, health: makeHealth('timeout') }));
    await index.add(makeRecord({ id: 'aaaa0005', seq: 5, health: makeHealth('error') }));
    await index.add(makeRecord({ id: 'aaaa0006', seq: 6, health: makeHealth('skipped') }));
    await index.add(makeRecord({ id: 'aaaa0007', seq: 7, health: null }));

    expect(index.lastHealthy()).toEqual(healthy);
    expect(index.latest()?.id).toBe('aaaa0007');
  });

  it('follows a health probe recorded after the fact by update()', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2 }));
    expect(index.lastHealthy()).toBeNull();

    await index.update('bbbb0002', { health: makeHealth('healthy') });

    expect(index.lastHealthy()?.id).toBe('bbbb0002');
    expect((await openIndex()).lastHealthy()?.id).toBe('bbbb0002');
  });

  it('forgets a snapshot was healthy once its health is patched back to null', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1, health: makeHealth('healthy') }));

    await index.update('aaaa0001', { health: null });

    expect(index.lastHealthy()).toBeNull();
    expect((await openIndex()).lastHealthy()).toBeNull();
  });

  it('points a panicking user at the health config when nothing has ever been healthy', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1, health: makeHealth('broken') }));

    const error = expectCode(() => index.resolve('healthy'), 'SNAPSHOT_NOT_FOUND');

    expect(error.message).toContain('No snapshot has ever passed the health check');
    expect(error.hint).not.toBeNull();
    expect(error.hint).toContain('health.command');
  });
});

describe('SnapshotIndex concurrent writers', () => {
  it('keeps lines from two processes appending at once from interleaving', async () => {
    const watcher = await openIndex();
    const cli = await openIndex();

    const writes: Promise<unknown>[] = [];
    for (let i = 0; i < 25; i += 1) {
      writes.push(
        watcher.add(makeRecord({ id: `w${String(i).padStart(7, '0')}`, seq: 1 + i * 2 })),
      );
      writes.push(cli.add(makeRecord({ id: `c${String(i).padStart(7, '0')}`, seq: 2 + i * 2 })));
    }
    await Promise.all(writes);

    const lines = await readLogLines();
    expect(lines).toHaveLength(50);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }

    const reopened = await openIndex();
    expect(reopened.size).toBe(50);
    expect(reopened.list().map((r) => r.seq)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
  });

  it('preserves the records a second writer added when the first one compacts', async () => {
    const first = await openIndex();
    await first.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    const second = await openIndex();
    await second.add(makeRecord({ id: 'bbbb0002', seq: 2 }));

    await first.compact();

    // `first` never saw bbbb0002, so compaction drops it. This is the documented
    // cost of the design: compaction is a whole-file rewrite from one process's
    // view, which is why only the lock-holding daemon should trigger it.
    const reopened = await openIndex();
    expect(reopened.list().map((r) => r.id)).toEqual(['aaaa0001']);
  });
});

describe('SnapshotIndex durability of the append path', () => {
  it('writes one newline-terminated json line per event', async () => {
    const index = await openIndex();
    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));
    await index.update('aaaa0001', { pinned: true });
    await index.add(makeRecord({ id: 'bbbb0002', seq: 2 }));
    await index.remove(['bbbb0002']);

    const raw = await fs.readFile(paths.index, 'utf8');

    expect(raw.endsWith('\n')).toBe(true);
    const kinds = raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => (JSON.parse(line) as { t: string }).t);
    expect(kinds).toEqual(['add', 'set', 'add', 'del']);
  });

  it('creates the store directory on the first append', async () => {
    const index = await openIndex();

    await index.add(makeRecord({ id: 'aaaa0001', seq: 1 }));

    await expect(fs.stat(paths.index)).resolves.toBeTruthy();
  });

  it('appends rather than truncating when reopened repeatedly', async () => {
    const created = await seedRecords(3);

    for (let round = 0; round < 3; round += 1) {
      const index = await openIndex();
      await index.add(makeRecord({ id: `extra${round}00`, seq: 10 + round }));
    }

    const reopened = await openIndex();
    expect(reopened.size).toBe(created.length + 3);
    expect(await readLogLines()).toHaveLength(6);
  });
});
