import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { defaultConfig, type TimeloomConfig } from '../src/config.js';
import type { IgnoreMatcher } from '../src/core/ignore.js';
import {
  absolutePathOf,
  buildIgnoreMatcher,
  scanTree,
  type ScanOptions,
} from '../src/core/scanner.js';
import { StatCache } from '../src/core/statcache.js';
import { silentLogger } from '../src/logger.js';
import type { FileEntry, ScanResult } from '../src/types.js';

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

/** A private temp tree per test, so the suite is safe to run in parallel. */
async function makeRoot(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-scan-'));
  // macOS hands out /var/folders/... which is a symlink to /private/var/...;
  // resolving it up front keeps path assertions honest on every platform.
  const real = await fs.realpath(created);
  roots.push(real);
  return real;
}

async function writeFile(
  root: string,
  repoPath: string,
  content: string | Buffer,
): Promise<string> {
  const absolute = path.join(root, ...repoPath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content);
  return absolute;
}

/**
 * Push every file's mtime into the past so the stat cache's racily-clean window
 * (2s) does not force a re-hash of files a test just created.
 */
async function ageTree(root: string, msInPast = 60_000): Promise<void> {
  const when = new Date(Date.now() - msInPast);
  const walk = async (dir: string): Promise<void> => {
    for (const dirent of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, dirent.name);
      if (dirent.isDirectory()) await walk(child);
      else if (dirent.isFile()) await fs.utimes(child, when, when);
    }
  };
  await walk(root);
}

function makeConfig(overrides: Partial<TimeloomConfig> = {}): TimeloomConfig {
  return { ...defaultConfig('en'), ...overrides };
}

async function scan(
  root: string,
  options: Partial<Omit<ScanOptions, 'root'>> = {},
): Promise<ScanResult> {
  return scanTree({
    root,
    config: makeConfig(),
    statCache: StatCache.empty(),
    logger: silentLogger,
    ...options,
  });
}

const pathsOf = (result: ScanResult): string[] => result.files.map((file) => file.path);

/** Independent hash oracle — deliberately not ObjectStore.hash, so the test can disagree. */
function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Basic walk                                                                  */
/* -------------------------------------------------------------------------- */

describe('scanTree file list', () => {
  it('returns tracked files sorted by repo path in code-point order', async () => {
    const root = await makeRoot();
    for (const repoPath of ['b.txt', 'ab.txt', 'a/b.txt', 'a.txt', 'Z.txt']) {
      await writeFile(root, repoPath, repoPath);
    }

    const result = await scan(root);

    // '.' (0x2E) < '/' (0x2F) < 'b', and uppercase sorts before lowercase.
    expect(pathsOf(result)).toEqual(['Z.txt', 'a.txt', 'a/b.txt', 'ab.txt', 'b.txt']);
  });

  it('reports repo-relative POSIX paths even on a platform with backslash separators', async () => {
    const root = await makeRoot();
    await writeFile(root, 'src/deep/nested/file.txt', 'x');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual(['src/deep/nested/file.txt']);
    expect(pathsOf(result)[0]).not.toContain('\\');
  });

  it('reports the byte length and SHA-256 of each file, not its character count', async () => {
    const root = await makeRoot();
    const multibyte = 'héllo — 世界';
    await writeFile(root, 'utf8.txt', multibyte);
    await writeFile(root, 'empty.txt', '');

    const result = await scan(root);

    expect(result.files.map(({ path: p, hash, size }) => ({ path: p, hash, size }))).toEqual([
      { path: 'empty.txt', hash: sha256(''), size: 0 },
      { path: 'utf8.txt', hash: sha256(multibyte), size: Buffer.byteLength(multibyte, 'utf8') },
    ]);
    expect(result.files[1]!.size).toBeGreaterThan(multibyte.length);
  });

  it('counts every freshly hashed file and reports a non-negative duration', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'b/c.txt', 'c');

    const result = await scan(root);

    expect(result.hashedCount).toBe(2);
    expect(result.cachedCount).toBe(0);
    expect(result.skipped).toEqual([]);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('walks a deeply nested tree iteratively instead of overflowing the stack', async () => {
    const root = await makeRoot();
    const depth = 60;
    const deepPath = `${Array.from({ length: depth }, (_, i) => `d${i}`).join('/')}/leaf.txt`;
    await writeFile(root, deepPath, 'bottom');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual([deepPath]);
    expect(result.files[0]!.hash).toBe(sha256('bottom'));
  });

  it('treats an empty project as a successful scan with no files', async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, 'empty-dir'), { recursive: true });

    const result = await scan(root);

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.hashedCount).toBe(0);
  });

  it('resolves a repo path to its on-disk location', () => {
    expect(absolutePathOf(path.sep === '\\' ? 'C:\\proj' : '/proj', 'src/a.txt')).toBe(
      path.join(path.sep === '\\' ? 'C:\\proj' : '/proj', 'src', 'a.txt'),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Default ignores                                                             */
/* -------------------------------------------------------------------------- */

describe('default ignore rules', () => {
  it('excludes node_modules, dist, .git and .timeloom without descending into them', async () => {
    const root = await makeRoot();
    await writeFile(root, 'index.js', 'tracked');
    await writeFile(root, 'src/app.js', 'tracked');

    // A dependency tree big enough that walking it would show up in hashedCount.
    const noise: Promise<unknown>[] = [];
    for (let pkg = 0; pkg < 10; pkg += 1) {
      for (let file = 0; file < 30; file += 1) {
        noise.push(writeFile(root, `node_modules/pkg${pkg}/src/f${file}.js`, 'junk'));
        noise.push(
          writeFile(root, `node_modules/pkg${pkg}/node_modules/inner/f${file}.js`, 'junk'),
        );
      }
    }
    noise.push(writeFile(root, 'dist/bundle.js', 'built'));
    noise.push(writeFile(root, 'dist/nested/chunk.js', 'built'));
    noise.push(writeFile(root, '.git/HEAD', 'ref: refs/heads/main'));
    noise.push(writeFile(root, '.git/objects/ab/cdef', 'obj'));
    noise.push(writeFile(root, '.timeloom/index.jsonl', '{}'));
    noise.push(writeFile(root, '.timeloom/objects/ab/cdef', 'blob'));
    await Promise.all(noise);

    const cache = StatCache.empty();
    const result = await scan(root, { statCache: cache });

    expect(pathsOf(result)).toEqual(['index.js', 'src/app.js']);
    // 600+ files exist under node_modules; the walk must not have opened any of them.
    expect(result.hashedCount).toBe(2);
    expect(result.skipped).toEqual([]);
    expect(cache.size).toBe(2);
  });

  it('excludes build output and editor junk matched by name patterns', async () => {
    const root = await makeRoot();
    await writeFile(root, 'keep.ts', 'keep');
    await writeFile(root, 'debug.log', 'noise');
    await writeFile(root, 'src/module.pyc', 'noise');
    await writeFile(root, '.DS_Store', 'noise');
    await writeFile(root, 'notes.txt~', 'noise');
    await writeFile(root, 'coverage/lcov.info', 'noise');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual(['keep.ts']);
  });
});

/* -------------------------------------------------------------------------- */
/* .gitignore integration                                                      */
/* -------------------------------------------------------------------------- */

describe('project .gitignore handling', () => {
  it('applies a nested .gitignore to its own subtree only', async () => {
    const root = await makeRoot();
    await writeFile(root, 'src/.gitignore', 'ignored.txt\n');
    await writeFile(root, 'src/ignored.txt', 'no');
    await writeFile(root, 'src/kept.txt', 'yes');
    await writeFile(root, 'other/ignored.txt', 'yes');
    await writeFile(root, 'ignored.txt', 'yes');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual([
      'ignored.txt',
      'other/ignored.txt',
      'src/.gitignore',
      'src/kept.txt',
    ]);
  });

  it('applies a root .gitignore to the whole tree', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', 'secret*\ntmp/\n');
    await writeFile(root, 'secret.env', 'no');
    await writeFile(root, 'deep/secret.env', 'no');
    await writeFile(root, 'tmp/scratch.txt', 'no');
    await writeFile(root, 'deep/keep.txt', 'yes');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual(['.gitignore', 'deep/keep.txt']);
  });

  it('ignores project .gitignore files entirely when useGitignore is false', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', 'secret.env\n');
    await writeFile(root, 'src/.gitignore', 'nested.txt\n');
    await writeFile(root, 'secret.env', 'now tracked');
    await writeFile(root, 'src/nested.txt', 'now tracked');

    const result = await scan(root, { config: makeConfig({ useGitignore: false }) });

    expect(pathsOf(result)).toEqual([
      '.gitignore',
      'secret.env',
      'src/.gitignore',
      'src/nested.txt',
    ]);
  });

  it('lets a project .gitignore re-include a directory the built-in defaults exclude', async () => {
    // Documented layering: built-in defaults are the weakest layer, so a project
    // that genuinely wants its `dist/` snapshotted can say so.
    const root = await makeRoot();
    await writeFile(root, '.gitignore', '!dist/\n');
    await writeFile(root, 'dist/bundle.js', 'built');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual(['.gitignore', 'dist/bundle.js']);
  });

  it('picks up an edited .gitignore on the next scan because the matcher is rebuilt', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', 'draft.md\n');
    await writeFile(root, 'draft.md', 'draft');

    const before = await scan(root);
    expect(pathsOf(before)).toEqual(['.gitignore']);

    await writeFile(root, '.gitignore', '# nothing ignored now\n');
    const after = await scan(root);

    expect(pathsOf(after)).toEqual(['.gitignore', 'draft.md']);
  });

  it('folds a nested ignore file into a reused matcher exactly once', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', 'a.txt\nb.txt\n');
    await writeFile(root, 'src/.gitignore', 'c.txt\n');
    await writeFile(root, 'src/keep.txt', 'keep');

    const matcher: IgnoreMatcher = buildIgnoreMatcher(makeConfig());
    const builtIn = matcher.ruleCount;

    const first = await scan(root, { matcher });
    const afterFirst = matcher.ruleCount;
    const second = await scan(root, { matcher });

    expect(afterFirst).toBeGreaterThan(builtIn);
    expect(matcher.ruleCount).toBe(afterFirst);
    expect(pathsOf(second)).toEqual(pathsOf(first));
  });
});

/* -------------------------------------------------------------------------- */
/* config.ignore                                                               */
/* -------------------------------------------------------------------------- */

describe('config.ignore has the last word', () => {
  it('excludes a file that the project .gitignore was happy to track', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', '# tracks everything\n');
    await writeFile(root, 'notes.txt', 'private');
    await writeFile(root, 'keep.txt', 'keep');

    const result = await scan(root, { config: makeConfig({ ignore: ['notes.txt'] }) });

    expect(pathsOf(result)).toEqual(['.gitignore', 'keep.txt']);
  });

  it('re-includes a file that the project .gitignore excluded', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', 'notes.txt\n');
    await writeFile(root, 'notes.txt', 'actually important');

    const ignored = await scan(root);
    expect(pathsOf(ignored)).toEqual(['.gitignore']);

    const result = await scan(root, { config: makeConfig({ ignore: ['!notes.txt'] }) });

    expect(pathsOf(result)).toEqual(['.gitignore', 'notes.txt']);
  });

  it('outranks a nested .gitignore deeper in the tree', async () => {
    const root = await makeRoot();
    await writeFile(root, 'src/.gitignore', 'generated.ts\n');
    await writeFile(root, 'src/generated.ts', 'generated');

    const result = await scan(root, { config: makeConfig({ ignore: ['!src/generated.ts'] }) });

    expect(pathsOf(result)).toEqual(['src/.gitignore', 'src/generated.ts']);
  });
});

/* -------------------------------------------------------------------------- */
/* Store self-protection (adversarial)                                         */
/* -------------------------------------------------------------------------- */

describe('store self-protection', () => {
  // BUG: buildIgnoreMatcher adds `.timeloom/` with addPatterns('', ...) — the same
  // bucket, and *earlier* than, the rules read from a project .gitignore. Because
  // last-match-wins inside a bucket, a single `!.timeloom/` line in a project's own
  // .gitignore re-includes the store, so the scanner walks .timeloom/objects and
  // snapshots the snapshots (every snapshot then roughly doubles the store — the
  // exact "delightful way to fill a disk" the source comment says this rule exists
  // to prevent). Expected: the store exclusion is unconditional (it belongs in
  // addFinalPatterns, or must be checked before the ignore matcher runs at all),
  // so no path under `.timeloom/` is ever returned. Actual: `.timeloom/index.jsonl`
  // and `.timeloom/objects/ab/cdef` are tracked.
  it('never tracks the .timeloom store even when a project .gitignore re-includes it', async () => {
    const root = await makeRoot();
    await writeFile(root, '.gitignore', '!.timeloom/\n');
    await writeFile(root, '.timeloom/index.jsonl', '{"id":"x"}');
    await writeFile(root, '.timeloom/objects/ab/cdef', 'blob');
    await writeFile(root, '.timeloom/statcache.json', '{}');
    await writeFile(root, 'app.js', 'tracked');

    const result = await scan(root);

    expect(pathsOf(result).filter((p) => p.startsWith('.timeloom'))).toEqual([]);
    expect(pathsOf(result)).toEqual(['.gitignore', 'app.js']);
  });

  it('excludes the store when nothing tries to re-include it', async () => {
    const root = await makeRoot();
    await writeFile(root, '.timeloom/index.jsonl', '{"id":"x"}');
    await writeFile(root, '.timeloom/objects/ab/cdef', 'blob');
    await writeFile(root, 'app.js', 'tracked');

    const result = await scan(root);

    expect(pathsOf(result)).toEqual(['app.js']);
  });
});

/* -------------------------------------------------------------------------- */
/* Skipped files                                                               */
/* -------------------------------------------------------------------------- */

describe('files the scanner refuses to track', () => {
  it('reports files above maxFileBytes as too-large and keeps them out of the file list', async () => {
    const root = await makeRoot();
    await writeFile(root, 'z-big.bin', Buffer.alloc(2_048, 1));
    await writeFile(root, 'a-big.bin', Buffer.alloc(4_096, 2));
    await writeFile(root, 'exact.bin', Buffer.alloc(1_024, 3));
    await writeFile(root, 'small.txt', 'ok');

    const result = await scan(root, { config: makeConfig({ maxFileBytes: 1_024 }) });

    // The boundary is exclusive: a file of exactly maxFileBytes is still tracked.
    expect(pathsOf(result)).toEqual(['exact.bin', 'small.txt']);
    expect(result.skipped).toEqual([
      { path: 'a-big.bin', reason: 'too-large', size: 4_096 },
      { path: 'z-big.bin', reason: 'too-large', size: 2_048 },
    ]);
    expect(result.hashedCount).toBe(2);
  });

  it('does not report an ignored oversized file at all', async () => {
    const root = await makeRoot();
    await writeFile(root, 'dist/huge.bin', Buffer.alloc(4_096, 1));

    const result = await scan(root, { config: makeConfig({ maxFileBytes: 1_024 }) });

    expect(result.files).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  // fs.symlink on Windows needs SeCreateSymbolicLinkPrivilege (admin shell or
  // Developer Mode), so creating the fixture fails with EPERM on an ordinary dev
  // box. The symlink branch of the walk is therefore asserted on POSIX only.
  describe.skipIf(process.platform === 'win32')('symlinks', () => {
    it('records a symlink as skipped and never follows it', async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      await writeFile(outside, 'escaped.txt', 'must not be tracked');
      await writeFile(root, 'real.txt', 'real');

      await fs.symlink(outside, path.join(root, 'link-to-dir'), 'dir');
      await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'link-to-file'));

      const result = await scan(root);

      expect(pathsOf(result)).toEqual(['real.txt']);
      expect(result.skipped).toEqual([
        { path: 'link-to-dir', reason: 'symlink', size: null },
        { path: 'link-to-file', reason: 'symlink', size: null },
      ]);
      expect(pathsOf(result).some((p) => p.includes('escaped'))).toBe(false);
    });

    it('does not report a symlink that the ignore rules already exclude', async () => {
      const root = await makeRoot();
      const outside = await makeRoot();
      await fs.symlink(outside, path.join(root, 'node_modules'), 'dir');
      await writeFile(root, 'app.js', 'tracked');

      const result = await scan(root);

      expect(pathsOf(result)).toEqual(['app.js']);
      expect(result.skipped).toEqual([]);
    });
  });

  // The executable bit is meaningless on Windows and the scanner hard-codes false
  // there, so this can only be asserted on POSIX.
  describe.skipIf(process.platform === 'win32')('executable bit', () => {
    it('records the executable bit for files that carry it', async () => {
      const root = await makeRoot();
      const script = await writeFile(root, 'run.sh', '#!/bin/sh\n');
      await writeFile(root, 'plain.txt', 'plain');
      await fs.chmod(script, 0o755);

      const result = await scan(root);

      expect(result.files.map((f) => [f.path, f.executable])).toEqual([
        ['plain.txt', false],
        ['run.sh', true],
      ]);
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'marks every file as non-executable on Windows',
    async () => {
      const root = await makeRoot();
      await writeFile(root, 'a.txt', 'a');

      const result = await scan(root);

      expect(result.files[0]!.executable).toBe(false);
    },
  );
});

/* -------------------------------------------------------------------------- */
/* onFile visitor                                                              */
/* -------------------------------------------------------------------------- */

describe('the onFile visitor', () => {
  it('hands over the bytes on a cache miss and null on a cache hit', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'alpha');
    await writeFile(root, 'nested/b.txt', 'bravo');
    await ageTree(root);

    const cache = StatCache.empty();
    const firstPass = new Map<string, Buffer | null>();
    const first = await scan(root, {
      statCache: cache,
      onFile: (entry, content) => {
        firstPass.set(entry.path, content);
      },
    });

    expect([...firstPass.keys()].sort()).toEqual(['a.txt', 'nested/b.txt']);
    expect(firstPass.get('a.txt')).toBeInstanceOf(Buffer);
    expect(firstPass.get('a.txt')!.toString('utf8')).toBe('alpha');
    expect(firstPass.get('nested/b.txt')!.toString('utf8')).toBe('bravo');
    expect(first.hashedCount).toBe(2);

    const secondPass = new Map<string, Buffer | null>();
    const entries: FileEntry[] = [];
    const second = await scan(root, {
      statCache: cache,
      onFile: (entry, content) => {
        secondPass.set(entry.path, content);
        entries.push(entry);
      },
    });

    expect(second.cachedCount).toBe(2);
    expect(secondPass.get('a.txt')).toBeNull();
    expect(secondPass.get('nested/b.txt')).toBeNull();
    // The entry handed to the visitor is the same one that lands in the result.
    expect([...entries].sort((a, b) => (a.path < b.path ? -1 : 1))).toEqual(second.files);
  });

  it('awaits an async visitor before finishing the scan', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'b.txt', 'b');

    let inFlight = 0;
    let maxInFlight = 0;
    const seen: string[] = [];
    const result = await scan(root, {
      onFile: async (entry) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        seen.push(entry.path);
        inFlight -= 1;
      },
    });

    expect(seen.sort()).toEqual(['a.txt', 'b.txt']);
    expect(maxInFlight).toBe(1);
    expect(result.files).toHaveLength(2);
  });
});

/* -------------------------------------------------------------------------- */
/* Stat cache behaviour through the scanner                                    */
/* -------------------------------------------------------------------------- */

describe('stat cache reuse across scans', () => {
  it('serves an unchanged tree entirely from the cache on the second scan', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'alpha');
    await writeFile(root, 'src/b.ts', 'bravo');
    await writeFile(root, 'src/deep/c.ts', 'charlie');
    await ageTree(root);

    const cache = StatCache.empty();
    const first = await scan(root, { statCache: cache });
    const second = await scan(root, { statCache: cache });

    expect(first.hashedCount).toBe(3);
    expect(first.cachedCount).toBe(0);
    expect(second.hashedCount).toBe(0);
    expect(second.cachedCount).toBe(second.files.length);
    expect(second.files).toEqual(first.files);
  });

  it('re-hashes an edited file and reports its new hash and size', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'before');
    await writeFile(root, 'b.txt', 'untouched');
    await ageTree(root);

    const cache = StatCache.empty();
    const first = await scan(root, { statCache: cache });
    expect(first.files[0]!.hash).toBe(sha256('before'));

    await writeFile(root, 'a.txt', 'after the edit');
    const second = await scan(root, { statCache: cache });

    expect(second.files[0]!.path).toBe('a.txt');
    expect(second.files[0]!.hash).toBe(sha256('after the edit'));
    expect(second.files[0]!.size).toBe(Buffer.byteLength('after the edit'));
    expect(second.files[0]!.hash).not.toBe(first.files[0]!.hash);
    expect(second.hashedCount).toBe(1);
  });

  it('re-hashes a file whose mtime sits inside the race window despite an exact stat match', async () => {
    const root = await makeRoot();
    const racy = await writeFile(root, 'racy.txt', 'same size!!');
    const settled = await writeFile(root, 'settled.txt', 'settled....');

    const longAgo = new Date(Date.now() - 60_000);
    await fs.utimes(settled, longAgo, longAgo);
    const now = new Date();
    await fs.utimes(racy, now, now);

    // Seed the cache with each file's *actual* stat, so size and mtime match
    // exactly and only the racily-clean guard can force a re-read.
    const cache = StatCache.empty();
    for (const [repoPath, absolute, content] of [
      ['racy.txt', racy, 'same size!!'],
      ['settled.txt', settled, 'settled....'],
    ] as const) {
      const stat = await fs.stat(absolute);
      cache.remember(repoPath, { size: stat.size, mtimeMs: stat.mtimeMs, hash: sha256(content) });
    }

    const result = await scan(root, { statCache: cache });

    expect(result.hashedCount).toBe(1);
    expect(result.cachedCount).toBe(1);
    expect(result.files.map((f) => f.hash)).toEqual([sha256('same size!!'), sha256('settled....')]);
  });

  it('re-reads a cached file whose hash is no longer backed by an object', async () => {
    const root = await makeRoot();
    await writeFile(root, 'kept.txt', 'kept content');
    await writeFile(root, 'pruned.txt', 'pruned content');
    await ageTree(root);

    const cache = StatCache.empty();
    const first = await scan(root, { statCache: cache });
    expect(first.hashedCount).toBe(2);

    const prunedHash = sha256('pruned content');
    const handedOver = new Map<string, Buffer | null>();
    const second = await scan(root, {
      statCache: cache,
      isStored: (hash) => Promise.resolve(hash !== prunedHash),
      onFile: (entry, content) => {
        handedOver.set(entry.path, content);
      },
    });

    expect(second.hashedCount).toBe(1);
    expect(second.cachedCount).toBe(1);
    expect(second.files).toEqual(first.files);
    expect(handedOver.get('kept.txt')).toBeNull();
    expect(handedOver.get('pruned.txt')).toBeInstanceOf(Buffer);
    expect(handedOver.get('pruned.txt')!.toString('utf8')).toBe('pruned content');
  });

  it('re-reads every file when nothing at all is stored any more', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'b.txt', 'b');
    await ageTree(root);

    const cache = StatCache.empty();
    const first = await scan(root, { statCache: cache });
    const second = await scan(root, { statCache: cache, isStored: () => Promise.resolve(false) });

    expect(second.hashedCount).toBe(2);
    expect(second.cachedCount).toBe(0);
    expect(second.files).toEqual(first.files);
  });

  it('drops cache entries for files that no longer exist so the cache cannot grow forever', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'b.txt', 'b');
    await writeFile(root, 'sub/c.txt', 'c');
    await ageTree(root);

    const cache = StatCache.empty();
    await scan(root, { statCache: cache });
    expect(cache.size).toBe(3);

    await fs.rm(path.join(root, 'b.txt'));
    await fs.rm(path.join(root, 'sub'), { recursive: true });
    const after = await scan(root, { statCache: cache });

    expect(pathsOf(after)).toEqual(['a.txt']);
    expect(cache.size).toBe(1);
    expect(cache.lookup('b.txt', 1, 0, Number.MAX_SAFE_INTEGER)).toBeNull();
  });

  it('drops cache entries for files that became ignored', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    await writeFile(root, 'b.txt', 'b');
    await ageTree(root);

    const cache = StatCache.empty();
    await scan(root, { statCache: cache });
    expect(cache.size).toBe(2);

    await scan(root, { statCache: cache, config: makeConfig({ ignore: ['b.txt'] }) });

    expect(cache.size).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* StatCache unit behaviour                                                    */
/* -------------------------------------------------------------------------- */

describe('StatCache lookup rules', () => {
  it('returns the cached hash only when size, mtime and the race window all agree', () => {
    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'deadbeef' });

    expect(cache.lookup('a.txt', 3, 10_000, 20_000)).toBe('deadbeef');
    expect(cache.lookup('missing.txt', 3, 10_000, 20_000)).toBeNull();
    expect(cache.lookup('a.txt', 4, 10_000, 20_000)).toBeNull();
    expect(cache.lookup('a.txt', 3, 10_001, 20_000)).toBeNull();
  });

  it('refuses a cached hash for anything written within 2s of the scan start', () => {
    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'deadbeef' });

    // Exactly on the boundary is still distrusted; one millisecond older is fine.
    expect(cache.lookup('a.txt', 3, 10_000, 12_000)).toBeNull();
    expect(cache.lookup('a.txt', 3, 10_000, 12_001)).toBe('deadbeef');
    expect(cache.lookup('a.txt', 3, 10_000, 9_000)).toBeNull();
  });

  it('distrusts a file whose mtime is in the future, as a skewed clock produces', () => {
    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 3, mtimeMs: 5_000_000, hash: 'deadbeef' });

    expect(cache.lookup('a.txt', 3, 5_000_000, 1_000)).toBeNull();
  });

  it('marks itself dirty when an entry is added or changed', () => {
    const cache = StatCache.empty();
    expect(cache.isDirty).toBe(false);

    cache.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'aaa' });
    expect(cache.isDirty).toBe(true);
    expect(cache.size).toBe(1);

    cache.remember('a.txt', { size: 4, mtimeMs: 11_000, hash: 'bbb' });
    expect(cache.size).toBe(1);
    expect(cache.lookup('a.txt', 4, 11_000, 1_000_000)).toBe('bbb');
  });

  it('forgets explicitly invalidated paths, as restore requires', () => {
    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 1, mtimeMs: 1_000, hash: 'aaa' });
    cache.remember('b.txt', { size: 1, mtimeMs: 1_000, hash: 'bbb' });

    cache.forget(['a.txt', 'never-seen.txt']);

    expect(cache.size).toBe(1);
    expect(cache.lookup('a.txt', 1, 1_000, 1_000_000)).toBeNull();
    expect(cache.lookup('b.txt', 1, 1_000, 1_000_000)).toBe('bbb');
  });

  it('retains only the live paths handed to it', () => {
    const cache = StatCache.empty();
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      cache.remember(name, { size: 1, mtimeMs: 1_000, hash: name });
    }

    cache.retainOnly(new Set(['b.txt']));

    expect(cache.size).toBe(1);
    expect(cache.lookup('b.txt', 1, 1_000, 1_000_000)).toBe('b.txt');
    expect(cache.lookup('a.txt', 1, 1_000, 1_000_000)).toBeNull();
  });

  it('empties itself when every path is gone', () => {
    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 1, mtimeMs: 1_000, hash: 'aaa' });

    cache.retainOnly(new Set());

    expect(cache.size).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* StatCache persistence                                                       */
/* -------------------------------------------------------------------------- */

describe('StatCache persistence', () => {
  it('survives a save and load round-trip', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');
    const tmp = path.join(root, 'tmp');

    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'aaa' });
    cache.remember('nested/b — ünicode.txt', { size: 9, mtimeMs: 20_000, hash: 'bbb' });
    expect(cache.isDirty).toBe(true);

    await cache.save(file, tmp);
    expect(cache.isDirty).toBe(false);

    const loaded = await StatCache.load(file);

    expect(loaded.size).toBe(2);
    expect(loaded.isDirty).toBe(false);
    expect(loaded.lookup('a.txt', 3, 10_000, 1_000_000)).toBe('aaa');
    expect(loaded.lookup('nested/b — ünicode.txt', 9, 20_000, 1_000_000)).toBe('bbb');
  });

  it('stays clean when a load is followed by re-remembering the identical triple', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');
    const tmp = path.join(root, 'tmp');

    const cache = StatCache.empty();
    cache.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'aaa' });
    await cache.save(file, tmp);

    const loaded = await StatCache.load(file);
    loaded.remember('a.txt', { size: 3, mtimeMs: 10_000, hash: 'aaa' });
    expect(loaded.isDirty).toBe(false);

    loaded.remember('a.txt', { size: 3, mtimeMs: 10_001, hash: 'aaa' });
    expect(loaded.isDirty).toBe(true);
  });

  it('does not rewrite the file when nothing changed since the last save', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');
    const tmp = path.join(root, 'tmp');

    await StatCache.empty().save(file, tmp);

    await expect(fs.stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('loads as an empty cache when the file does not exist', async () => {
    const root = await makeRoot();

    const loaded = await StatCache.load(path.join(root, 'nope.json'));

    expect(loaded.size).toBe(0);
    expect(loaded.isDirty).toBe(false);
  });

  it('degrades to an empty cache when the file is corrupt instead of throwing', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');
    await fs.writeFile(file, '{"v":1,"entries":{"a.txt":[1,2,"aaa"');

    const loaded = await StatCache.load(file);

    expect(loaded.size).toBe(0);
  });

  it('degrades to an empty cache when the file is valid JSON of the wrong shape', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');

    for (const body of ['null', '[]', '"a string"', '{"v":2,"entries":{"a.txt":[1,2,"aaa"]}}']) {
      await fs.writeFile(file, body);
      const loaded = await StatCache.load(file);
      expect(loaded.size).toBe(0);
    }
  });

  it('drops individual malformed entries but keeps the well-formed ones', async () => {
    const root = await makeRoot();
    const file = path.join(root, 'statcache.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        v: 1,
        savedAt: 0,
        entries: {
          'good.txt': [3, 10_000, 'aaa'],
          'short.txt': [3, 10_000],
          'not-an-array.txt': { size: 3 },
          'bad-size.txt': ['3', 10_000, 'aaa'],
          'bad-mtime.txt': [3, null, 'aaa'],
          'bad-hash.txt': [3, 10_000, 42],
        },
      }),
    );

    const loaded = await StatCache.load(file);

    expect(loaded.size).toBe(1);
    expect(loaded.lookup('good.txt', 3, 10_000, 1_000_000)).toBe('aaa');
  });

  it('keeps a scanner-populated cache usable after a restart', async () => {
    const root = await makeRoot();
    const project = path.join(root, 'project');
    const cacheFile = path.join(root, 'statcache.json');
    const tmp = path.join(root, 'tmp');
    await writeFile(project, 'a.txt', 'alpha');
    await writeFile(project, 'src/b.ts', 'bravo');
    await ageTree(project);

    const cache = StatCache.empty();
    const first = await scan(project, { statCache: cache });
    await cache.save(cacheFile, tmp);

    const reloaded = await StatCache.load(cacheFile);
    const second = await scan(project, { statCache: reloaded });

    expect(second.hashedCount).toBe(0);
    expect(second.cachedCount).toBe(2);
    expect(second.files).toEqual(first.files);
  });
});

/* -------------------------------------------------------------------------- */
/* Cancellation                                                                */
/* -------------------------------------------------------------------------- */

describe('cancellation', () => {
  it('rejects with the abort reason when the signal is already aborted', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');

    const controller = new AbortController();
    controller.abort(new Error('cancelled before we started'));

    await expect(scan(root, { signal: controller.signal })).rejects.toThrow(
      'cancelled before we started',
    );
  });

  it('stops walking as soon as the signal is aborted mid-scan', async () => {
    const root = await makeRoot();
    for (let i = 0; i < 8; i += 1) {
      await writeFile(root, `f${i}.txt`, `file ${i}`);
    }

    const controller = new AbortController();
    const visited: string[] = [];

    await expect(
      scan(root, {
        signal: controller.signal,
        onFile: (entry) => {
          visited.push(entry.path);
          controller.abort(new Error('cancelled mid-scan'));
        },
      }),
    ).rejects.toThrow('cancelled mid-scan');

    expect(visited).toHaveLength(1);
  });

  it('completes normally when the signal is never aborted', async () => {
    const root = await makeRoot();
    await writeFile(root, 'a.txt', 'a');
    const controller = new AbortController();

    const result = await scan(root, { signal: controller.signal });

    expect(pathsOf(result)).toEqual(['a.txt']);
  });
});
