import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObjectStore } from '../src/core/cas.js';
import { TimeloomError, isTimeloomError } from '../src/errors.js';
import type { TimeloomErrorCode } from '../src/errors.js';

/**
 * Every test gets its own temp tree. `root` is the sandbox, `objectsDir`/`tmpDir`
 * mirror what `repoPaths()` hands the real store.
 */
let root: string;
let objectsDir: string;
let tmpDir: string;
let store: ObjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-cas-'));
  objectsDir = path.join(root, 'store', 'objects');
  tmpDir = path.join(root, 'store', 'tmp');
  store = new ObjectStore(objectsDir, tmpDir);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

// --- helpers ---------------------------------------------------------------

async function captureError(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to throw, but it resolved');
}

async function expectTimeloomError(
  run: () => unknown,
  code: TimeloomErrorCode,
): Promise<TimeloomError> {
  const error = await captureError(run);
  if (!isTimeloomError(error)) {
    throw new Error(
      `expected a TimeloomError with code ${code}, got ${
        error instanceof Error ? `${error.name}: ${error.message}` : String(error)
      }`,
    );
  }
  expect(error.code).toBe(code);
  return error;
}

/** The on-disk path of an object, computed independently of the code under test. */
function rawObjectPath(hash: string): string {
  return path.join(objectsDir, hash.slice(0, 2), hash.slice(2));
}

async function readRawObject(hash: string): Promise<Buffer> {
  return fs.readFile(rawObjectPath(hash));
}

async function writeRawObject(hash: string, payload: Buffer): Promise<void> {
  const target = rawObjectPath(hash);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, payload);
}

async function collect(iterable: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/** Highly compressible: long runs of one byte deflate to almost nothing. */
function compressible(bytes: number): Buffer {
  return Buffer.alloc(bytes, 0x61);
}

/**
 * Two distinct payloads whose hashes land in the same two-hex shard directory.
 * Found by deterministic search so the test never depends on chance.
 */
function sameShardPair(): [Buffer, Buffer] {
  const seen = new Map<string, Buffer>();
  for (let i = 0; i < 100_000; i += 1) {
    const candidate = Buffer.from(`shard-probe-${i}`, 'utf8');
    const shard = ObjectStore.hash(candidate).slice(0, 2);
    const previous = seen.get(shard);
    if (previous !== undefined) return [previous, candidate];
    seen.set(shard, candidate);
  }
  throw new Error('no two probes shared a shard — the search bound is wrong');
}

const VALID_HASH = 'a'.repeat(64);

// --- hashing ---------------------------------------------------------------

describe('ObjectStore.hash', () => {
  it('produces the standard SHA-256 hex digest of the empty input', () => {
    expect(ObjectStore.hash(Buffer.alloc(0))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('hashes a string exactly as it hashes that string encoded as UTF-8', () => {
    const text = 'abc — 中文 🌍';
    expect(ObjectStore.hash(text)).toBe(ObjectStore.hash(Buffer.from(text, 'utf8')));
    expect(ObjectStore.hash('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('always yields a 64-character lowercase hex string that objectPath accepts', () => {
    for (const sample of [Buffer.alloc(0), Buffer.from('x'), randomBytes(2_000)]) {
      const hash = ObjectStore.hash(sample);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(() => store.objectPath(hash)).not.toThrow();
    }
  });
});

// --- round-trip ------------------------------------------------------------

describe('put/get round-trip', () => {
  const cases: [name: string, make: () => Buffer][] = [
    ['empty content', () => Buffer.alloc(0)],
    ['a single byte', () => Buffer.from([0x00])],
    ['small ASCII text', () => Buffer.from('hello world\n', 'utf8')],
    [
      'UTF-8 multibyte text (CJK, Cyrillic, emoji, combining marks)',
      () => Buffer.from('café 中文 мир 🌍👩‍👩‍👧‍👦 e\u0301\n'.repeat(40), 'utf8'),
    ],
    [
      'binary content containing every byte value including NUL',
      () => Buffer.from(Array.from({ length: 256 }, (_, i) => i)),
    ],
    ['content one byte below the 512-byte compression floor', () => compressible(511)],
    ['content exactly at the 512-byte compression floor', () => compressible(512)],
    ['large highly compressible content (1 MiB of one byte)', () => compressible(1024 * 1024)],
    ['large incompressible binary content (1 MiB of random bytes)', () => randomBytes(1024 * 1024)],
  ];

  for (const [name, make] of cases) {
    it(`returns byte-identical content for ${name}`, async () => {
      const data = make();
      const result = await store.put(data);

      expect(result.hash).toBe(ObjectStore.hash(data));
      expect(result.stored).toBe(true);

      const readBack = await store.get(result.hash);
      expect(readBack.byteLength).toBe(data.byteLength);
      expect(readBack.equals(data)).toBe(true);
      // Re-hashing what came out must reproduce the key it was filed under.
      expect(ObjectStore.hash(readBack)).toBe(result.hash);
    });
  }

  it('preserves the exact string when UTF-8 multibyte text is decoded again', async () => {
    const text = '中文测试 — naïve café 🌍 \u{1F469}\u200D\u{1F4BB}';
    const { hash } = await store.put(Buffer.from(text, 'utf8'));
    const readBack = await store.get(hash);
    expect(readBack.toString('utf8')).toBe(text);
    // Guards against anyone "helpfully" treating content as latin1/UCS-2.
    expect(readBack.byteLength).toBeGreaterThan(text.length);
  });

  it('reports has() true only after the object has actually been stored', async () => {
    const data = Buffer.from('presence check', 'utf8');
    const hash = ObjectStore.hash(data);
    expect(await store.has(hash)).toBe(false);
    await store.put(data);
    expect(await store.has(hash)).toBe(true);
  });

  it('files an object under a two-character shard directory inside the objects dir', async () => {
    const { hash } = await store.put(Buffer.from('shard layout', 'utf8'));
    const target = store.objectPath(hash);
    expect(target).toBe(path.join(objectsDir, hash.slice(0, 2), hash.slice(2)));
    expect(path.relative(objectsDir, target).startsWith('..')).toBe(false);
    await expect(fs.stat(target)).resolves.toBeDefined();
  });

  it('leaves no temporary files behind after a successful put', async () => {
    await store.put(randomBytes(4_096));
    const leftovers = await fs.readdir(tmpDir);
    expect(leftovers).toEqual([]);
  });
});

// --- deduplication ---------------------------------------------------------

describe('deduplication', () => {
  it('reports stored:false and writes zero bytes when identical content is put twice', async () => {
    const data = Buffer.from('the marginal cost of a snapshot is the bytes that changed', 'utf8');

    const first = await store.put(data);
    const before = await store.stats();
    const second = await store.put(data);
    const after = await store.stats();

    expect(first.stored).toBe(true);
    expect(first.storedBytes).toBeGreaterThan(0);
    expect(second.hash).toBe(first.hash);
    expect(second.stored).toBe(false);
    expect(second.storedBytes).toBe(0);
    expect(after).toEqual(before);
    expect(after.objectCount).toBe(1);
  });

  it('does not grow the store when the same large content is put many times', async () => {
    const data = compressible(64 * 1024);
    const first = await store.put(data);
    for (let i = 0; i < 5; i += 1) {
      const repeat = await store.put(Buffer.from(data));
      expect(repeat.stored).toBe(false);
      expect(repeat.storedBytes).toBe(0);
    }
    const stats = await store.stats();
    expect(stats.objectCount).toBe(1);
    expect(stats.totalBytes).toBe(first.storedBytes);
  });

  it('keeps distinct content distinct even when it differs by a single byte', async () => {
    const a = Buffer.from('rollback point alpha', 'utf8');
    const b = Buffer.from('rollback point alphb', 'utf8');
    const first = await store.put(a);
    const second = await store.put(b);

    expect(second.hash).not.toBe(first.hash);
    expect(second.stored).toBe(true);
    expect((await store.get(first.hash)).equals(a)).toBe(true);
    expect((await store.get(second.hash)).equals(b)).toBe(true);
    expect((await store.stats()).objectCount).toBe(2);
  });

  it('is idempotent: put, get, put again yields the same hash and no new bytes', async () => {
    const data = randomBytes(3_000);
    const first = await store.put(data);
    const readBack = await store.get(first.hash);
    const again = await store.put(readBack);
    expect(again.hash).toBe(first.hash);
    expect(again.stored).toBe(false);
    expect(again.storedBytes).toBe(0);
  });

  it('stores exactly one object when the same content is put concurrently', async () => {
    // Two snapshots racing on the same new file is the documented reason the rename
    // failure path exists. Whatever the interleaving, the store must end consistent.
    const data = Buffer.from('racing writers write identical bytes', 'utf8');
    const results = await Promise.all(Array.from({ length: 8 }, () => store.put(data)));

    const hash = ObjectStore.hash(data);
    expect(results.every((result) => result.hash === hash)).toBe(true);
    expect(await collect(store.listHashes())).toEqual([hash]);
    expect((await store.get(hash)).equals(data)).toBe(true);
    expect(await fs.readdir(tmpDir)).toEqual([]);
  });
});

// --- compression heuristic -------------------------------------------------

describe('the compression heuristic', () => {
  it('stores highly compressible content smaller than the input and still round-trips', async () => {
    const data = Buffer.from('the quick brown fox jumps over the lazy dog\n'.repeat(2_000), 'utf8');
    const result = await store.put(data);

    expect(result.storedBytes).toBeLessThan(data.byteLength);
    expect((await store.get(result.hash)).equals(data)).toBe(true);
    expect((await store.stats()).totalBytes).toBe(result.storedBytes);
  });

  it('never stores incompressible content larger than the input plus one marker byte', async () => {
    // Source trees are full of png/woff2/jpg; re-deflating them must not cost bytes.
    const data = randomBytes(256 * 1024);
    const result = await store.put(data);

    expect(result.storedBytes).toBeLessThanOrEqual(data.byteLength + 1);
    expect((await store.get(result.hash)).equals(data)).toBe(true);
  });

  it('round-trips content that deflate makes bigger', async () => {
    // Already-deflated bytes: compressing again is guaranteed to be a loss.
    const inner = randomBytes(64 * 1024);
    const result = await store.put(inner);
    expect(result.storedBytes).toBeLessThanOrEqual(inner.byteLength + 1);
    expect((await store.get(result.hash)).equals(inner)).toBe(true);
  });

  it('skips compression entirely below the 512-byte floor, costing exactly one marker byte', async () => {
    const data = compressible(511);
    const result = await store.put(data);
    expect(result.storedBytes).toBe(512);
    expect((await store.get(result.hash)).equals(data)).toBe(true);
  });

  it('compresses highly compressible content once it reaches the 512-byte floor', async () => {
    const data = compressible(512);
    const result = await store.put(data);
    expect(result.storedBytes).toBeLessThan(data.byteLength);
    expect((await store.get(result.hash)).equals(data)).toBe(true);
  });

  it('round-trips every size straddling the compression floor', async () => {
    for (const size of [0, 1, 510, 511, 512, 513, 1_024]) {
      const data = compressible(size);
      const { hash } = await store.put(data);
      const readBack = await store.get(hash);
      expect(readBack.byteLength, `size ${size}`).toBe(size);
      expect(readBack.equals(data), `size ${size}`).toBe(true);
    }
  });

  it('round-trips compressible binary content that contains NUL bytes', async () => {
    const data = Buffer.alloc(8_192, 0x00);
    const result = await store.put(data);
    expect(result.storedBytes).toBeLessThan(data.byteLength);
    expect((await store.get(result.hash)).equals(data)).toBe(true);
  });
});

// --- integrity -------------------------------------------------------------

describe('get integrity verification', () => {
  it('raises CORRUPT_OBJECT when a stored object no longer matches its hash', async () => {
    const data = Buffer.from('content that will rot on disk', 'utf8');
    const { hash } = await store.put(data);

    const payload = await readRawObject(hash);
    const corrupted = Buffer.from(payload);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! ^ 0xff) & 0xff;
    await fs.writeFile(rawObjectPath(hash), corrupted);

    const error = await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
    expect(error.message).toContain(hash.slice(0, 12));
    expect(error.hint).toBeTruthy();
  });

  it('returns the unverified bytes when { verify: false } is passed', async () => {
    const data = Buffer.from('content that will rot on disk', 'utf8');
    const { hash } = await store.put(data);

    const payload = await readRawObject(hash);
    const corrupted = Buffer.from(payload);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1]! ^ 0xff) & 0xff;
    await fs.writeFile(rawObjectPath(hash), corrupted);

    const unverified = await store.get(hash, { verify: false });
    expect(unverified.byteLength).toBe(data.byteLength);
    expect(unverified.equals(data)).toBe(false);
    expect(ObjectStore.hash(unverified)).not.toBe(hash);
  });

  it('verifies by default when the options object omits verify', async () => {
    const data = compressible(4_096);
    const { hash } = await store.put(data);
    await writeRawObject(
      hash,
      Buffer.concat([Buffer.from([0x00]), Buffer.from('not the content')]),
    );
    await expectTimeloomError(() => store.get(hash, {}), 'CORRUPT_OBJECT');
  });

  it('accepts an object whose bytes are intact when verification is on', async () => {
    const data = compressible(4_096);
    const { hash } = await store.put(data);
    expect((await store.get(hash, { verify: true })).equals(data)).toBe(true);
  });

  it('raises CORRUPT_OBJECT for an empty object file, even with verification off', async () => {
    const hash = ObjectStore.hash(Buffer.from('will be truncated to nothing', 'utf8'));
    await writeRawObject(hash, Buffer.alloc(0));

    const error = await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
    expect(error.message).toContain(hash.slice(0, 12));
    // { verify: false } skips the hash check only — a structurally broken object is
    // still an error, never an empty buffer handed to the restore writer.
    await expectTimeloomError(() => store.get(hash, { verify: false }), 'CORRUPT_OBJECT');
  });

  it('raises CORRUPT_OBJECT when a compressed object is truncated mid-stream', async () => {
    const data = compressible(16_384);
    const { hash, storedBytes } = await store.put(data);
    const payload = await readRawObject(hash);
    expect(storedBytes).toBeLessThan(data.byteLength); // precondition: it was deflated

    await fs.writeFile(rawObjectPath(hash), payload.subarray(0, 3));
    const error = await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
    expect(error.message).toContain(hash.slice(0, 12));
    await expectTimeloomError(() => store.get(hash, { verify: false }), 'CORRUPT_OBJECT');
  });

  it('raises CORRUPT_OBJECT when a compressed object body is garbage', async () => {
    const data = compressible(16_384);
    const { hash } = await store.put(data);
    const payload = await readRawObject(hash);
    await fs.writeFile(
      rawObjectPath(hash),
      Buffer.concat([payload.subarray(0, 1), Buffer.from('this is not a deflate stream')]),
    );
    await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
  });

  it('raises CORRUPT_OBJECT for an unknown leading encoding marker', async () => {
    const hash = ObjectStore.hash(Buffer.from('written by a future version', 'utf8'));
    for (const marker of [0x02, 0x7f, 0xff]) {
      await writeRawObject(hash, Buffer.concat([Buffer.from([marker]), Buffer.from('payload')]));
      const error = await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
      expect(error.message).toContain(marker.toString(16));
      expect(error.hint).toContain('newer version');
    }
  });

  it('raises OBJECT_MISSING rather than a bare ENOENT for an absent object', async () => {
    const hash = ObjectStore.hash(Buffer.from('never stored', 'utf8'));
    const error = await expectTimeloomError(() => store.get(hash), 'OBJECT_MISSING');
    expect(error.message).toContain(hash.slice(0, 12));
    expect(error.hint).toBeTruthy();
    // The errno is preserved as the cause so `doctor` can still see it, but the
    // caller-facing failure is the documented code, not a raw fs error.
    expect(isTimeloomError(error)).toBe(true);
  });

  it('raises OBJECT_MISSING when the objects directory does not exist at all', async () => {
    const hash = ObjectStore.hash(Buffer.from('empty store', 'utf8'));
    const fresh = new ObjectStore(path.join(root, 'nonexistent', 'objects'), tmpDir);
    await expectTimeloomError(() => fresh.get(hash), 'OBJECT_MISSING');
    expect(await fresh.has(hash)).toBe(false);
  });
});

// --- security: hash shape is a path guard ----------------------------------

describe('objectPath rejects untrusted hashes', () => {
  // A hash arriving from a snapshot record someone else produced is attacker
  // controlled. It must be shape-checked before it can ever become a path.
  const REJECTED: [label: string, hash: string][] = [
    ['the empty string', ''],
    ['a relative traversal', '../../escape'],
    ['a POSIX absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\System32\\config\\SAM'],
    ['a UNC path', '\\\\server\\share\\secret'],
    ['a single dot', '.'],
    ['a double dot', '..'],
    ['backslash traversal', '..\\..\\escape'],
    ['64 non-hex characters', 'Z'.repeat(64)],
    ['64 uppercase hex characters', 'A'.repeat(64)],
    ['63 hex characters', 'a'.repeat(63)],
    ['65 hex characters', 'a'.repeat(65)],
    ['64 characters containing a path separator', `${'a'.repeat(31)}/${'a'.repeat(32)}`],
    ['64 characters containing a backslash', `${'a'.repeat(31)}\\${'a'.repeat(32)}`],
    ['64 characters containing a NUL byte', `${'a'.repeat(31)}\0${'a'.repeat(32)}`],
    ['64 characters with trailing whitespace', `${'a'.repeat(63)} `],
    ['a valid hash with a trailing newline', `${VALID_HASH}\n`],
    ['a valid hash with a traversal suffix', `${VALID_HASH}/../../escape`],
    ['a hash-shaped string of spaces', ' '.repeat(64)],
    ['a Windows reserved device name', 'nul'],
    ['a hash with an alternate data stream suffix', `${VALID_HASH}:stream`],
  ];

  for (const [label, hash] of REJECTED) {
    it(`throws CORRUPT_OBJECT instead of resolving a path for ${label}`, async () => {
      expect(() => store.objectPath(hash)).toThrow(TimeloomError);
      await expectTimeloomError(() => store.objectPath(hash), 'CORRUPT_OBJECT');
    });

    it(`refuses every hash-taking operation for ${label}`, async () => {
      await expectTimeloomError(() => store.has(hash), 'CORRUPT_OBJECT');
      await expectTimeloomError(() => store.get(hash), 'CORRUPT_OBJECT');
      await expectTimeloomError(() => store.get(hash, { verify: false }), 'CORRUPT_OBJECT');
      await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
      await expectTimeloomError(() => store.delete(hash), 'CORRUPT_OBJECT');
    });
  }

  it('accepts a well-formed lowercase hex hash', () => {
    expect(() => store.objectPath(VALID_HASH)).not.toThrow();
    expect(() => store.objectPath('0123456789abcdef'.repeat(4))).not.toThrow();
  });

  it('does not read a file outside the objects directory via a traversing hash', async () => {
    // '../../escape' would join to <root>/escape if the guard were absent.
    const decoy = path.join(root, 'escape');
    await fs.mkdir(objectsDir, { recursive: true });
    await fs.writeFile(decoy, 'ATTACKER-READABLE-SECRET', 'utf8');

    await expectTimeloomError(() => store.get('../../escape'), 'CORRUPT_OBJECT');
    expect(await fs.readFile(decoy, 'utf8')).toBe('ATTACKER-READABLE-SECRET');
  });

  it('does not delete a file outside the objects directory via a traversing hash', async () => {
    const decoy = path.join(root, 'escape');
    await fs.mkdir(objectsDir, { recursive: true });
    await fs.writeFile(decoy, 'DO-NOT-DELETE', 'utf8');

    await expectTimeloomError(() => store.delete('../../escape'), 'CORRUPT_OBJECT');
    expect(await fs.readFile(decoy, 'utf8')).toBe('DO-NOT-DELETE');
  });

  it('reports a rejected hash verbatim in the error message so the bad record is findable', async () => {
    const error = await expectTimeloomError(
      () => store.objectPath('../../escape'),
      'CORRUPT_OBJECT',
    );
    expect(error.message).toContain('../../escape');
  });
});

// --- JSON ------------------------------------------------------------------

describe('putJson / getJson', () => {
  it('round-trips a nested JSON-serialisable value', async () => {
    const value = {
      v: 1,
      files: [
        { path: 'src/app.ts', hash: VALID_HASH, size: 42, executable: false },
        { path: 'src/中文.ts', hash: 'b'.repeat(64), size: 0, executable: true },
      ],
      label: null,
    };
    const { hash } = await store.putJson(value);
    expect(await store.getJson<typeof value>(hash)).toEqual(value);
  });

  it('round-trips JSON containing multibyte characters and escapes', async () => {
    const value = { note: 'café 中文 🌍 "quoted" \\ backslash \n newline \t tab' };
    const { hash } = await store.putJson(value);
    expect((await store.getJson<typeof value>(hash)).note).toBe(value.note);
  });

  it('dedupes identical JSON values, so identical trees are stored once', async () => {
    const value = { v: 1, files: [] };
    const first = await store.putJson(value);
    const second = await store.putJson({ v: 1, files: [] });
    expect(second.hash).toBe(first.hash);
    expect(second.stored).toBe(false);
    expect((await store.stats()).objectCount).toBe(1);
  });

  it('round-trips JSON scalars including null and the empty array', async () => {
    for (const value of [null, 0, false, '', [], {}]) {
      const { hash } = await store.putJson(value);
      expect(await store.getJson(hash)).toEqual(value);
    }
  });

  it('round-trips a JSON payload large enough to be compressed', async () => {
    const value = {
      v: 1,
      files: Array.from({ length: 500 }, (_, i) => ({
        path: `src/module-${i}/index.ts`,
        hash: ObjectStore.hash(`file-${i}`),
        size: i,
        executable: false,
      })),
    };
    const result = await store.putJson(value);
    expect(result.storedBytes).toBeLessThan(JSON.stringify(value).length);
    expect(await store.getJson<typeof value>(result.hash)).toEqual(value);
  });

  it('raises CORRUPT_OBJECT when the object is not valid JSON', async () => {
    const { hash } = await store.put(Buffer.from('this is definitely not json {{{', 'utf8'));
    const error = await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
    expect(error.message).toContain(hash.slice(0, 12));
    expect(error.message).toContain('JSON');
  });

  it('raises CORRUPT_OBJECT when the object is empty content rather than JSON', async () => {
    const { hash } = await store.put(Buffer.alloc(0));
    await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
  });

  it('raises CORRUPT_OBJECT when the object is truncated JSON', async () => {
    const { hash } = await store.put(Buffer.from('{"v":1,"files":[', 'utf8'));
    await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
  });

  it('raises CORRUPT_OBJECT when the object is arbitrary binary content', async () => {
    const { hash } = await store.put(Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80]));
    await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
  });

  it('raises OBJECT_MISSING when the JSON object is not in the store', async () => {
    await expectTimeloomError(() => store.getJson(VALID_HASH), 'OBJECT_MISSING');
  });

  it('verifies the hash before parsing, so corrupt JSON reports corruption', async () => {
    const { hash } = await store.putJson({ v: 1 });
    await writeRawObject(hash, Buffer.concat([Buffer.from([0x00]), Buffer.from('{"v":2}')]));
    const error = await expectTimeloomError(() => store.getJson(hash), 'CORRUPT_OBJECT');
    expect(error.message).toContain('integrity');
  });
});

// --- listing ---------------------------------------------------------------

describe('listHashes', () => {
  it('yields nothing for a store whose objects directory has never been created', async () => {
    expect(await collect(store.listHashes())).toEqual([]);
  });

  it('yields exactly the hashes that were put, in sorted order', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 25; i += 1) {
      const result = await store.put(Buffer.from(`object-${i}`, 'utf8'));
      hashes.push(result.hash);
    }

    const listed = await collect(store.listHashes());
    expect(listed).toEqual([...hashes].sort());
    expect(new Set(listed).size).toBe(listed.length);
  });

  it('yields the same set regardless of insertion order', async () => {
    const payloads = Array.from({ length: 12 }, (_, i) => Buffer.from(`payload-${i}`, 'utf8'));
    for (const payload of payloads) await store.put(payload);
    const first = await collect(store.listHashes());

    const other = new ObjectStore(
      path.join(root, 'store2', 'objects'),
      path.join(root, 'store2', 'tmp'),
    );
    for (const payload of [...payloads].reverse()) await other.put(payload);
    expect(await collect(other.listHashes())).toEqual(first);
  });

  it('ignores junk files and stray directories in the objects directory', async () => {
    const kept: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      kept.push((await store.put(Buffer.from(`kept-${i}`, 'utf8'))).hash);
    }

    // Junk at the shard level: wrong-length names, non-hex names, a stray directory
    // and a plain file sitting where a shard directory would be.
    await fs.writeFile(path.join(objectsDir, 'README.txt'), 'not an object', 'utf8');
    await fs.writeFile(path.join(objectsDir, 'zz'), 'two chars but not hex', 'utf8');
    await fs.mkdir(path.join(objectsDir, 'incoming'), { recursive: true });
    await fs.writeFile(path.join(objectsDir, 'incoming', 'x'), 'x', 'utf8');
    await fs.mkdir(path.join(objectsDir, 'g0'), { recursive: true });
    await fs.writeFile(path.join(objectsDir, 'g0', 'f'.repeat(62)), 'non-hex shard', 'utf8');
    await fs.mkdir(path.join(objectsDir, 'ABC'), { recursive: true });

    // Junk inside a legitimate shard: wrong-length entry names, uppercase hex, and a
    // stray subdirectory.
    const shard = path.join(objectsDir, 'ab');
    await fs.mkdir(shard, { recursive: true });
    await fs.writeFile(path.join(shard, 'not-a-hash'), 'junk', 'utf8');
    await fs.writeFile(path.join(shard, 'c'.repeat(61)), 'too short', 'utf8');
    await fs.writeFile(path.join(shard, 'c'.repeat(63)), 'too long', 'utf8');
    await fs.writeFile(path.join(shard, 'C'.repeat(62)), 'uppercase hex', 'utf8');
    await fs.writeFile(path.join(shard, `${'c'.repeat(58)}.tmp`), 'partial write', 'utf8');
    await fs.mkdir(path.join(shard, 'quarantine'), { recursive: true });

    expect(await collect(store.listHashes())).toEqual([...kept].sort());
  });

  it('survives a shard directory that vanishes between readdir calls', async () => {
    // Concurrent gc removing a shard must not turn listing into a crash.
    await store.put(Buffer.from('one', 'utf8'));
    await fs.mkdir(path.join(objectsDir, 'ff'), { recursive: true });
    await fs.rmdir(path.join(objectsDir, 'ff'));
    expect((await collect(store.listHashes())).length).toBe(1);
  });

  it('stops yielding a hash once it has been deleted', async () => {
    const a = await store.put(Buffer.from('a', 'utf8'));
    const b = await store.put(Buffer.from('b', 'utf8'));
    await store.delete(a.hash);
    expect(await collect(store.listHashes())).toEqual([b.hash]);
  });
});

// --- corrupt store shapes --------------------------------------------------

/**
 * A directory sitting where an object file belongs.
 *
 * `listHashes` filters shard entries by *name* only (`/^[0-9a-f]{62}$/`) and never
 * asks whether the entry is a file. A directory whose name happens to be 62 hex
 * characters is therefore indistinguishable from an object, and every consumer of
 * `listHashes` — notably garbage collection in src/core/prune.ts, which iterates
 * `store.listHashes()` and calls `store.delete()` on what it finds — trips over it
 * with a raw errno instead of a TimeloomError.
 */
describe('a directory sitting where an object file belongs', () => {
  const STRAY_BODY = 'd'.repeat(62);
  const STRAY_HASH = `ab${STRAY_BODY}`;

  async function makeStrayDirectory(): Promise<void> {
    await fs.mkdir(path.join(objectsDir, 'ab', STRAY_BODY), { recursive: true });
  }

  // BUG: listHashes yields the stray directory as if it were a stored object.
  // cas.ts:204 tests only the entry NAME (`/^[0-9a-f]{62}$/`) and never the entry
  // TYPE, so `objects/ab/dddd…` (a directory) is emitted alongside real hashes.
  // Expected: listHashes yields only the one real object. Actual: it yields two
  // entries, the second being 'ab' + 'd'.repeat(62).
  // Fix: read shards with `fs.readdir(dir, { withFileTypes: true })` and require
  // `entry.isFile()` before yielding.
  it('does not yield a stray directory inside a shard whose name is object-shaped', async () => {
    const real = await store.put(Buffer.from('a genuine object', 'utf8'));
    await makeStrayDirectory();
    expect(await collect(store.listHashes())).toEqual([real.hash]);
  });

  // BUG: get() lets a raw EISDIR escape instead of raising a TimeloomError.
  // cas.ts:128 only maps ENOENT/ENOTDIR to OBJECT_MISSING, so `fs.readFile` on a
  // directory rejects with a plain `Error` carrying `code: 'EISDIR'`
  // ("EISDIR: illegal operation on a directory, read"). Expected: a TimeloomError
  // (OBJECT_MISSING or CORRUPT_OBJECT are both defensible) so the CLI can render a
  // hint. Actual: a bare errno reaches the caller and `timeloom doctor` reports an
  // unhandled crash. Fix: add 'EISDIR' to the isErrno guard in get().
  it('raises a TimeloomError, not a raw EISDIR, when an object path is a directory', async () => {
    await makeStrayDirectory();
    const error = await captureError(() => store.get(STRAY_HASH));
    expect(isTimeloomError(error)).toBe(true);
  });

  // BUG: delete() crashes on the stray directory, which takes garbage collection
  // down with it. `fs.stat` succeeds (it is a real directory), then
  // `fs.rm(target, { force: true })` at cas.ts:178 runs WITHOUT `recursive: true`
  // and throws `SystemError` with `code: 'ERR_FS_EISDIR'`
  // ("Path is a directory: rm returned EISDIR (is a directory) …").
  // `force: true` does not cover this — it only suppresses ENOENT.
  // Expected: delete() reclaims nothing and returns 0 (or raises CORRUPT_OBJECT),
  // never a raw SystemError. Actual: prune.ts:187's gc loop dies. Fix: skip
  // non-file entries, or catch EISDIR/ERR_FS_EISDIR and return 0.
  it('does not crash garbage collection when deleting a directory-shaped entry', async () => {
    await makeStrayDirectory();
    await expect(store.delete(STRAY_HASH)).resolves.toBe(0);
  });

  // BUG: stats() counts the stray directory as an object. Follows directly from the
  // listHashes defect above — `fs.stat` on a directory succeeds, contributing an
  // objectCount of 1 and 0 bytes, so `timeloom status` overstates the object count.
  // Expected: { objectCount: 0, totalBytes: 0 } for a store containing only a stray
  // directory. Actual: { objectCount: 1, totalBytes: 0 }.
  it('does not count a stray directory as a stored object', async () => {
    await makeStrayDirectory();
    expect(await store.stats()).toEqual({ objectCount: 0, totalBytes: 0 });
  });
});

// --- deletion --------------------------------------------------------------

describe('delete', () => {
  it('returns the number of bytes actually reclaimed from disk', async () => {
    const data = randomBytes(4_096);
    const { hash, storedBytes } = await store.put(data);
    const before = await store.stats();

    expect(await store.delete(hash)).toBe(storedBytes);

    const after = await store.stats();
    expect(before.totalBytes - after.totalBytes).toBe(storedBytes);
    expect(after.objectCount).toBe(0);
    expect(await store.has(hash)).toBe(false);
  });

  it('returns the compressed byte count, not the original size, for a compressed object', async () => {
    const data = compressible(32 * 1024);
    const { hash, storedBytes } = await store.put(data);
    expect(storedBytes).toBeLessThan(data.byteLength);
    expect(await store.delete(hash)).toBe(storedBytes);
  });

  it('returns 0 and does nothing for a hash that was never stored', async () => {
    expect(await store.delete(VALID_HASH)).toBe(0);
    expect((await store.stats()).objectCount).toBe(0);
  });

  it('returns 0 on the second delete of the same hash', async () => {
    const { hash, storedBytes } = await store.put(Buffer.from('delete me twice', 'utf8'));
    expect(await store.delete(hash)).toBe(storedBytes);
    expect(await store.delete(hash)).toBe(0);
  });

  it('returns 0 when the objects directory does not exist', async () => {
    const fresh = new ObjectStore(path.join(root, 'never-created', 'objects'), tmpDir);
    expect(await fresh.delete(VALID_HASH)).toBe(0);
  });

  it('makes a deleted object raise OBJECT_MISSING on the next get', async () => {
    const { hash } = await store.put(Buffer.from('gone after gc', 'utf8'));
    await store.delete(hash);
    await expectTimeloomError(() => store.get(hash), 'OBJECT_MISSING');
  });

  it('allows the same content to be stored again after deletion', async () => {
    const data = Buffer.from('resurrected', 'utf8');
    const first = await store.put(data);
    await store.delete(first.hash);
    const again = await store.put(data);
    expect(again.hash).toBe(first.hash);
    expect(again.stored).toBe(true);
    expect(again.storedBytes).toBe(first.storedBytes);
    expect((await store.get(again.hash)).equals(data)).toBe(true);
  });

  it('removes the shard directory once its last object is gone', async () => {
    const { hash } = await store.put(Buffer.from('lonely object', 'utf8'));
    const shard = path.dirname(store.objectPath(hash));
    await expect(fs.stat(shard)).resolves.toBeDefined();
    await store.delete(hash);
    await expect(fs.stat(shard)).rejects.toThrow();
  });

  it('leaves a sibling object intact when deleting one of two in the same shard', async () => {
    const [first, second] = sameShardPair();
    const a = await store.put(first);
    const b = await store.put(second);
    expect(a.hash.slice(0, 2)).toBe(b.hash.slice(0, 2));

    await store.delete(a.hash);

    expect(await store.has(a.hash)).toBe(false);
    expect((await store.get(b.hash)).equals(second)).toBe(true);
    expect(await collect(store.listHashes())).toEqual([b.hash]);
  });
});

// --- stats -----------------------------------------------------------------

describe('stats', () => {
  it('reports zero for a store that has never been written to', async () => {
    expect(await store.stats()).toEqual({ objectCount: 0, totalBytes: 0 });
  });

  it('counts every stored object and sums the bytes actually on disk', async () => {
    let expectedBytes = 0;
    for (let i = 0; i < 10; i += 1) {
      const result = await store.put(Buffer.from(`stat-object-${i}`.repeat(i + 1), 'utf8'));
      expectedBytes += result.storedBytes;
    }
    expect(await store.stats()).toEqual({ objectCount: 10, totalBytes: expectedBytes });
  });

  it('mixes compressed and raw objects and still sums the on-disk sizes', async () => {
    const a = await store.put(compressible(64 * 1024));
    const b = await store.put(randomBytes(64 * 1024));
    const c = await store.put(Buffer.from('tiny', 'utf8'));

    const stats = await store.stats();
    expect(stats.objectCount).toBe(3);
    expect(stats.totalBytes).toBe(a.storedBytes + b.storedBytes + c.storedBytes);
    expect(stats.totalBytes).toBeLessThan(64 * 1024 + 64 * 1024 + 4);
  });

  it('does not count junk files that listHashes ignores', async () => {
    const { storedBytes } = await store.put(Buffer.from('the only real object', 'utf8'));
    await fs.writeFile(path.join(objectsDir, 'notes.md'), 'x'.repeat(10_000), 'utf8');
    await fs.mkdir(path.join(objectsDir, 'ab'), { recursive: true });
    await fs.writeFile(path.join(objectsDir, 'ab', 'junk'), 'y'.repeat(10_000), 'utf8');

    expect(await store.stats()).toEqual({ objectCount: 1, totalBytes: storedBytes });
  });

  it('shrinks to zero after everything has been deleted', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      hashes.push((await store.put(Buffer.from(`ephemeral-${i}`, 'utf8'))).hash);
    }
    for (const hash of hashes) await store.delete(hash);
    expect(await store.stats()).toEqual({ objectCount: 0, totalBytes: 0 });
  });
});
