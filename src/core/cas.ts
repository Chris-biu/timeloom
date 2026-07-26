import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as zlib from 'node:zlib';

import { TimeloomError, isErrno } from '../errors.js';
import { ensureDir, syncDirectory } from '../util/fsx.js';

const deflate = promisify(zlib.deflate);
const inflate = promisify(zlib.inflate);

/**
 * First byte of every stored object records how the payload was encoded. Source
 * trees are full of already-compressed assets (png, woff2, jpg); re-deflating them
 * burns CPU to make the file marginally *bigger*.
 */
const ENCODING_RAW = 0x00;
const ENCODING_DEFLATE = 0x01;

/** Only keep the compressed form if it actually saved something worth the CPU. */
const COMPRESSION_ACCEPT_RATIO = 0.95;

/** Objects below this size are never worth a deflate round-trip. */
const COMPRESSION_MIN_BYTES = 512;

export interface PutResult {
  hash: string;
  /** False when the object was already present — this is the deduplication signal. */
  stored: boolean;
  /** Bytes actually written to disk. Zero for a dedup hit. */
  storedBytes: number;
}

export interface ObjectStoreStats {
  objectCount: number;
  totalBytes: number;
}

/**
 * A content-addressed blob store.
 *
 * Objects are keyed by the SHA-256 of their *uncompressed* content, so a file that
 * appears in a thousand snapshots is stored exactly once. That is what makes
 * snapshotting on every save affordable: the marginal cost of a snapshot is the
 * bytes that actually changed, not the size of the tree.
 *
 * Layout mirrors git's: `objects/ab/cdef...`, sharded two hex characters deep so no
 * single directory accumulates hundreds of thousands of entries.
 */
export class ObjectStore {
  constructor(
    private readonly objectsDir: string,
    private readonly tmpDir: string,
  ) {}

  static hash(data: Buffer | string): string {
    return createHash('sha256').update(data).digest('hex');
  }

  objectPath(hash: string): string {
    assertHash(hash);
    return path.join(this.objectsDir, hash.slice(0, 2), hash.slice(2));
  }

  async has(hash: string): Promise<boolean> {
    try {
      await fs.stat(this.objectPath(hash));
      return true;
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return false;
      throw error;
    }
  }

  /**
   * Store `data`, returning its hash. Writing an object that already exists is a
   * cheap no-op — the whole design depends on that being the common case.
   */
  async put(data: Buffer): Promise<PutResult> {
    const hash = ObjectStore.hash(data);
    const target = this.objectPath(hash);
    if (await this.has(hash)) {
      return { hash, stored: false, storedBytes: 0 };
    }

    const payload = await encode(data);
    await ensureDir(path.dirname(target));
    await ensureDir(this.tmpDir);
    const tmpPath = path.join(this.tmpDir, `o-${randomUUID()}`);
    const handle = await fs.open(tmpPath, 'wx');
    try {
      await handle.writeFile(payload);
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await fs.rename(tmpPath, target);
    } catch (error) {
      await fs.rm(tmpPath, { force: true });
      // Two snapshots racing on the same new file both write it. Identical content,
      // identical name — whoever lost the race already has what it needed.
      if (isErrno(error, 'EEXIST', 'EPERM', 'EACCES') && (await this.has(hash))) {
        return { hash, stored: false, storedBytes: 0 };
      }
      throw error;
    }
    await syncDirectory(path.dirname(target));
    return { hash, stored: true, storedBytes: payload.byteLength };
  }

  /**
   * Read an object back.
   *
   * The hash is re-verified by default. Restore is the one operation where silently
   * writing corrupted bytes over the user's working files would be unforgivable, and
   * bit rot in a store that lives for months is not hypothetical.
   */
  async get(hash: string, options: { verify?: boolean } = {}): Promise<Buffer> {
    const verify = options.verify ?? true;
    const target = this.objectPath(hash);
    let payload: Buffer;
    try {
      payload = await fs.readFile(target);
    } catch (error) {
      // EISDIR belongs here too: a directory sitting at an object path is a corrupt
      // store, not a programming error, and the caller needs a code it can render a
      // hint for rather than a bare errno escaping into `timeloom doctor`.
      if (isErrno(error, 'ENOENT', 'ENOTDIR', 'EISDIR')) {
        throw new TimeloomError('OBJECT_MISSING', `Object ${hash.slice(0, 12)} is missing`, {
          cause: error,
          hint: 'The snapshot store is incomplete. Run `timeloom doctor` to see what is recoverable.',
        });
      }
      throw error;
    }

    const data = await decode(payload, hash);
    if (verify) {
      const actual = ObjectStore.hash(data);
      if (actual !== hash) {
        throw new TimeloomError(
          'CORRUPT_OBJECT',
          `Object ${hash.slice(0, 12)} failed its integrity check`,
          {
            hint: 'The stored file does not match its hash. Run `timeloom doctor --repair` to quarantine it.',
          },
        );
      }
    }
    return data;
  }

  async putJson(value: unknown): Promise<PutResult> {
    return this.put(Buffer.from(JSON.stringify(value), 'utf8'));
  }

  async getJson<T>(hash: string): Promise<T> {
    const data = await this.get(hash);
    try {
      return JSON.parse(data.toString('utf8')) as T;
    } catch (error) {
      throw new TimeloomError('CORRUPT_OBJECT', `Object ${hash.slice(0, 12)} is not valid JSON`, {
        cause: error,
      });
    }
  }

  async delete(hash: string): Promise<number> {
    const target = this.objectPath(hash);
    let size = 0;
    try {
      const stat = await fs.lstat(target);
      // Anything that is not a plain file did not come from `put`. Removing it is not
      // this method's job, and `fs.rm` without `recursive` throws on a directory —
      // which would abort the garbage collection sweep partway through and leave the
      // store in a worse state than the stray entry did.
      if (!stat.isFile()) return 0;
      size = stat.size;
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return 0;
      throw error;
    }
    await fs.rm(target, { force: true });
    // Shard directories go empty as history is pruned; leaving 256 empty dirs behind
    // is untidy but harmless, so failure here is ignored.
    await fs.rmdir(path.dirname(target)).catch(() => undefined);
    return size;
  }

  /**
   * Every hash currently in the store. Used by garbage collection and by `stats`.
   *
   * Entries are matched on both name *and* type. A name-only check would emit a
   * directory that happens to be named like a hash, and every consumer downstream —
   * the GC sweep, the object count in `timeloom status` — would then treat it as a
   * stored object.
   */
  async *listHashes(): AsyncGenerator<string> {
    let shards;
    try {
      shards = await fs.readdir(this.objectsDir, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT', 'ENOTDIR')) return;
      throw error;
    }

    const shardNames = shards
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{2}$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();

    for (const shard of shardNames) {
      let entries;
      try {
        entries = await fs.readdir(path.join(this.objectsDir, shard), { withFileTypes: true });
      } catch (error) {
        if (isErrno(error, 'ENOENT', 'ENOTDIR')) continue;
        throw error;
      }
      const names = entries
        .filter((entry) => entry.isFile() && /^[0-9a-f]{62}$/.test(entry.name))
        .map((entry) => entry.name)
        .sort();
      for (const name of names) {
        yield shard + name;
      }
    }
  }

  async stats(): Promise<ObjectStoreStats> {
    let objectCount = 0;
    let totalBytes = 0;
    for await (const hash of this.listHashes()) {
      try {
        const stat = await fs.lstat(this.objectPath(hash));
        if (!stat.isFile()) continue;
        objectCount += 1;
        totalBytes += stat.size;
      } catch (error) {
        if (!isErrno(error, 'ENOENT', 'ENOTDIR')) throw error;
      }
    }
    return { objectCount, totalBytes };
  }
}

async function encode(data: Buffer): Promise<Buffer> {
  if (data.byteLength < COMPRESSION_MIN_BYTES) {
    return Buffer.concat([Buffer.from([ENCODING_RAW]), data]);
  }
  const compressed = await deflate(data);
  if (compressed.byteLength >= data.byteLength * COMPRESSION_ACCEPT_RATIO) {
    return Buffer.concat([Buffer.from([ENCODING_RAW]), data]);
  }
  return Buffer.concat([Buffer.from([ENCODING_DEFLATE]), compressed]);
}

async function decode(payload: Buffer, hash: string): Promise<Buffer> {
  const marker = payload[0];
  if (marker === undefined) {
    throw new TimeloomError('CORRUPT_OBJECT', `Object ${hash.slice(0, 12)} is empty`);
  }
  const body = payload.subarray(1);
  switch (marker) {
    case ENCODING_RAW:
      return body;
    case ENCODING_DEFLATE:
      try {
        return await inflate(body);
      } catch (error) {
        throw new TimeloomError(
          'CORRUPT_OBJECT',
          `Object ${hash.slice(0, 12)} could not be decompressed`,
          { cause: error },
        );
      }
    default:
      throw new TimeloomError(
        'CORRUPT_OBJECT',
        `Object ${hash.slice(0, 12)} has an unknown encoding marker 0x${marker.toString(16)}`,
        { hint: 'This store was probably written by a newer version of timeloom.' },
      );
  }
}

const HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertHash(hash: string): void {
  if (!HASH_PATTERN.test(hash)) {
    // Guards the object path against traversal: a hash arriving from a snapshot
    // record is untrusted input until it has been shape-checked.
    throw new TimeloomError('CORRUPT_OBJECT', `Not a valid object hash: ${JSON.stringify(hash)}`);
  }
}
