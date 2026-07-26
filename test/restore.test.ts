import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ObjectStore } from '../src/core/cas.js';
import { applyRestore, planRestore } from '../src/core/restore.js';
import { isTimeloomError, TimeloomError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import type { FileEntry, SkippedFile } from '../src/types.js';
import { pruneEmptyDirsUpward, resolveWithin } from '../src/util/fsx.js';

const POSIX_ONLY = process.platform === 'win32';

let tempRoot: string;
let projectRoot: string;
let objectsDir: string;
let tmpDir: string;
let store: ObjectStore;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-restore-'));
  projectRoot = path.join(tempRoot, 'project');
  objectsDir = path.join(tempRoot, 'store', 'objects');
  tmpDir = path.join(tempRoot, 'store', 'tmp');
  await fs.mkdir(projectRoot, { recursive: true });
  await fs.mkdir(objectsDir, { recursive: true });
  await fs.mkdir(tmpDir, { recursive: true });
  store = new ObjectStore(objectsDir, tmpDir);
});

afterEach(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

/** Write a file into the working tree and return the entry a scan would produce. */
async function place(repoPath: string, contents: string, executable = false): Promise<FileEntry> {
  const absolute = path.join(projectRoot, ...repoPath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, contents, 'utf8');
  const data = Buffer.from(contents, 'utf8');
  return { path: repoPath, hash: ObjectStore.hash(data), size: data.byteLength, executable };
}

/** Register content in the object store and return the entry that points at it. */
async function store_(repoPath: string, contents: string, executable = false): Promise<FileEntry> {
  const data = Buffer.from(contents, 'utf8');
  const { hash } = await store.put(data);
  return { path: repoPath, hash, size: data.byteLength, executable };
}

async function readTree(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  async function walk(dir: string, prefix: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const child = path.join(dir, entry.name);
      const repoPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(child, repoPath);
      } else if (entry.isFile()) {
        out[repoPath] = await fs.readFile(child, 'utf8');
      }
    }
  }
  await walk(projectRoot, '');
  return out;
}

function context() {
  return { root: projectRoot, store, tmpDir, logger: silentLogger };
}

// ---------------------------------------------------------------------------
// resolveWithin — the single chokepoint protecting every write
// ---------------------------------------------------------------------------

describe('resolveWithin', () => {
  it('resolves an ordinary relative path inside the root', () => {
    expect(resolveWithin('/tmp/proj', 'src/index.ts')).toBe(
      path.resolve('/tmp/proj', 'src', 'index.ts'),
    );
  });

  it('resolves the empty-ish root path itself without escaping', () => {
    expect(resolveWithin('/tmp/proj', 'a')).toBe(path.resolve('/tmp/proj', 'a'));
  });

  const escapes: [name: string, input: string][] = [
    ['a parent-directory reference', '../outside'],
    ['a traversal buried mid-path', 'a/../../outside'],
    ['a traversal that only just escapes', 'a/b/../../../outside'],
    ['a POSIX absolute path', '/etc/passwd'],
    ['a Windows absolute path', 'C:\\Windows\\system32'],
    ['a Windows drive-relative path', 'C:foo'],
    ['an empty path', ''],
  ];

  for (const [name, input] of escapes) {
    it(`refuses ${name}`, () => {
      expect(() => resolveWithin('/tmp/proj', input)).toThrow(TimeloomError);
      try {
        resolveWithin('/tmp/proj', input);
      } catch (error) {
        expect(isTimeloomError(error) && error.code).toBe('PATH_ESCAPE');
      }
    });
  }

  it('refuses a path containing a NUL byte', () => {
    // A NUL truncates the path at the syscall boundary on POSIX, so `a\0/../../x`
    // reaching the filesystem is not the path that was validated.
    expect(() => resolveWithin('/tmp/proj', `a${String.fromCharCode(0)}b`)).toThrow(TimeloomError);
  });

  const reserved = ['CON', 'con.txt', 'PRN', 'AUX', 'NUL', 'a/NUL', 'COM1', 'lpt9.log'];
  for (const input of reserved) {
    it(`refuses the Windows reserved device name ${input}`, () => {
      // Writing to one of these does not create a file; it talks to a device.
      expect(() => resolveWithin('/tmp/proj', input)).toThrow(TimeloomError);
    });
  }

  it('refuses a sibling directory that merely shares the root as a string prefix', () => {
    // The classic prefix-match bug: `/tmp/project-other` starts with `/tmp/project`
    // but is emphatically not inside it.
    const root = path.join(tempRoot, 'project');
    expect(() => resolveWithin(root, '../project-other/file.txt')).toThrow(TimeloomError);
  });

  it('allows a path whose own name begins with a dot', () => {
    expect(() => resolveWithin('/tmp/proj', '.env')).not.toThrow();
    expect(() => resolveWithin('/tmp/proj', '.github/workflows/ci.yml')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// planRestore — direction is the thing that is easy to get backwards
// ---------------------------------------------------------------------------

describe('planRestore', () => {
  it('writes files the target has and the working tree does not', async () => {
    const current: FileEntry[] = [];
    const target = [await store_('src/a.ts', 'a')];

    const plan = planRestore('s1', current, target, []);

    expect(plan.write.map((item) => item.entry.path)).toEqual(['src/a.ts']);
    expect(plan.write[0]?.change.status).toBe('added');
    expect(plan.delete).toEqual([]);
  });

  it('deletes files the working tree has and the target does not', async () => {
    const current = [await store_('src/gone.ts', 'x')];

    const plan = planRestore('s1', current, [], []);

    expect(plan.write).toEqual([]);
    expect(plan.delete.map((change) => change.path)).toEqual(['src/gone.ts']);
    expect(plan.delete[0]?.status).toBe('deleted');
  });

  it('overwrites a file whose content differs', async () => {
    const current = [await store_('a.ts', 'old')];
    const target = [await store_('a.ts', 'new')];

    const plan = planRestore('s1', current, target, []);

    expect(plan.write.map((item) => item.entry.path)).toEqual(['a.ts']);
    expect(plan.write[0]?.change.status).toBe('modified');
  });

  it('leaves an identical file out of the plan entirely', async () => {
    const entry = await store_('a.ts', 'same');

    const plan = planRestore('s1', [entry], [entry], []);

    expect(plan.write).toEqual([]);
    expect(plan.delete).toEqual([]);
  });

  it('carries the untouched list through so the caller can warn about it', async () => {
    const untouched: SkippedFile[] = [{ path: 'big.bin', reason: 'too-large', size: 99 }];

    const plan = planRestore('s1', [], [await store_('a.ts', 'a')], untouched);

    expect(plan.untouched).toEqual(untouched);
  });
});

// ---------------------------------------------------------------------------
// applyRestore
// ---------------------------------------------------------------------------

describe('applyRestore', () => {
  it('writes exactly the bytes the snapshot recorded', async () => {
    const target = [await store_('src/deep/nested/a.ts', 'hello world')];

    const result = await applyRestore(context(), planRestore('s1', [], target, []));

    expect(result.written).toBe(1);
    expect(await readTree()).toEqual({ 'src/deep/nested/a.ts': 'hello world' });
  });

  it('creates parent directories that do not exist yet', async () => {
    const target = [await store_('a/b/c/d.txt', 'deep')];

    await applyRestore(context(), planRestore('s1', [], target, []));

    await expect(fs.readFile(path.join(projectRoot, 'a', 'b', 'c', 'd.txt'), 'utf8')).resolves.toBe(
      'deep',
    );
  });

  it('removes directories that its deletions emptied', async () => {
    const current = [await place('feature/one.ts', '1'), await place('feature/two.ts', '2')];

    const result = await applyRestore(context(), planRestore('s1', current, [], []));

    expect(result.deleted).toBe(2);
    await expect(fs.stat(path.join(projectRoot, 'feature'))).rejects.toThrow();
  });

  it('keeps a directory that still holds a file after the deletions', async () => {
    const keep = await place('feature/keep.ts', 'k');
    const drop = await place('feature/drop.ts', 'd');

    await applyRestore(context(), planRestore('s1', [keep, drop], [keep], []));

    await expect(fs.stat(path.join(projectRoot, 'feature'))).resolves.toBeDefined();
    expect(await readTree()).toEqual({ 'feature/keep.ts': 'k' });
  });

  it('is idempotent: applying the same plan twice leaves the same tree', async () => {
    const target = [await store_('a.ts', 'once'), await store_('b/c.ts', 'twice')];
    const plan = planRestore('s1', [], target, []);

    await applyRestore(context(), plan);
    const first = await readTree();
    await applyRestore(context(), plan);

    expect(await readTree()).toEqual(first);
  });

  it('deletes before writing, so a file can become a directory', async () => {
    // `config` exists as a file now and must exist as a directory afterwards. Writing
    // first would fail with ENOTDIR; the ordering is what makes this work.
    const current = [await place('config', 'i am a file')];
    const target = [await store_('config/settings.json', '{}')];

    await applyRestore(context(), planRestore('s1', current, target, []));

    expect(await readTree()).toEqual({ 'config/settings.json': '{}' });
  });

  it('reports a directory sitting where a file should be written, without crashing', async () => {
    await fs.mkdir(path.join(projectRoot, 'blocked'), { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'blocked', 'child.txt'), 'x', 'utf8');
    const target = [await store_('blocked', 'should be a file')];

    const result = await applyRestore(context(), planRestore('s1', [], target, []));

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([{ path: 'blocked', reason: 'a directory is in the way' }]);
  });

  it('refuses a target path that escapes the project directory', async () => {
    // A store is data. A snapshot record carrying `../` must not be able to write
    // outside the tree it belongs to, whoever produced it.
    const rogue: FileEntry = {
      path: '../escaped.txt',
      hash: (await store.put(Buffer.from('pwned', 'utf8'))).hash,
      size: 5,
      executable: false,
    };

    await expect(applyRestore(context(), planRestore('s1', [], [rogue], []))).rejects.toThrow(
      TimeloomError,
    );

    await expect(fs.stat(path.join(tempRoot, 'escaped.txt'))).rejects.toThrow();
  });

  it('surfaces a missing object rather than writing a truncated file', async () => {
    const phantom: FileEntry = {
      path: 'a.ts',
      hash: 'f'.repeat(64),
      size: 3,
      executable: false,
    };

    await expect(applyRestore(context(), planRestore('s1', [], [phantom], []))).rejects.toThrow(
      TimeloomError,
    );
  });

  it('counts the bytes it wrote', async () => {
    const target = [await store_('a.ts', 'abcde'), await store_('b.ts', 'fg')];

    const result = await applyRestore(context(), planRestore('s1', [], target, []));

    expect(result.bytesWritten).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// Symlinks — following one is how a write escapes the project
// ---------------------------------------------------------------------------

describe.skipIf(POSIX_ONLY)('symlink handling', () => {
  // Skipped on Windows: creating a symlink there needs Developer Mode or elevation,
  // so the test would report an environment problem as a product failure.

  it('refuses to write through a symlink and reports it instead', async () => {
    const outside = path.join(tempRoot, 'outside.txt');
    await fs.writeFile(outside, 'original', 'utf8');
    await fs.symlink(outside, path.join(projectRoot, 'link.txt'));

    const target = [await store_('link.txt', 'overwritten')];
    const result = await applyRestore(context(), planRestore('s1', [], target, []));

    expect(result.written).toBe(0);
    expect(result.skipped).toEqual([{ path: 'link.txt', reason: 'is a symbolic link' }]);
    // The crucial assertion: the file the link pointed at is untouched.
    await expect(fs.readFile(outside, 'utf8')).resolves.toBe('original');
  });

  it('refuses to delete a symlink and reports it instead', async () => {
    const outside = path.join(tempRoot, 'outside.txt');
    await fs.writeFile(outside, 'original', 'utf8');
    await fs.symlink(outside, path.join(projectRoot, 'link.txt'));

    const current: FileEntry[] = [
      { path: 'link.txt', hash: 'a'.repeat(64), size: 8, executable: false },
    ];
    const result = await applyRestore(context(), planRestore('s1', current, [], []));

    expect(result.deleted).toBe(0);
    expect(result.skipped).toEqual([{ path: 'link.txt', reason: 'is a symbolic link' }]);
    await expect(fs.lstat(path.join(projectRoot, 'link.txt'))).resolves.toBeDefined();
  });
});

describe.skipIf(POSIX_ONLY)('permissions', () => {
  it('restores the executable bit, because a script without it is a broken project', async () => {
    const target = [await store_('run.sh', '#!/bin/sh\necho hi\n', true)];

    await applyRestore(context(), planRestore('s1', [], target, []));

    const stat = await fs.stat(path.join(projectRoot, 'run.sh'));
    expect(stat.mode & 0o111).not.toBe(0);
  });

  it('leaves a non-executable file non-executable', async () => {
    const target = [await store_('notes.md', '# hi\n', false)];

    await applyRestore(context(), planRestore('s1', [], target, []));

    const stat = await fs.stat(path.join(projectRoot, 'notes.md'));
    expect(stat.mode & 0o111).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// pruneEmptyDirsUpward
// ---------------------------------------------------------------------------

describe('pruneEmptyDirsUpward', () => {
  it('removes a chain of empty directories up to but not including the root', async () => {
    const deep = path.join(projectRoot, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });

    await pruneEmptyDirsUpward(projectRoot, deep);

    await expect(fs.stat(path.join(projectRoot, 'a'))).rejects.toThrow();
    await expect(fs.stat(projectRoot)).resolves.toBeDefined();
  });

  it('stops at the first directory that still holds something', async () => {
    const deep = path.join(projectRoot, 'a', 'b', 'c');
    await fs.mkdir(deep, { recursive: true });
    await fs.writeFile(path.join(projectRoot, 'a', 'keep.txt'), 'k', 'utf8');

    await pruneEmptyDirsUpward(projectRoot, deep);

    await expect(fs.stat(path.join(projectRoot, 'a'))).resolves.toBeDefined();
    await expect(fs.stat(path.join(projectRoot, 'a', 'b'))).rejects.toThrow();
  });

  it('does nothing when the starting directory does not exist', async () => {
    await expect(
      pruneEmptyDirsUpward(projectRoot, path.join(projectRoot, 'never', randomUUID())),
    ).resolves.toBeUndefined();
  });

  it('never removes the root itself, even when it is empty', async () => {
    await pruneEmptyDirsUpward(projectRoot, projectRoot);

    await expect(fs.stat(projectRoot)).resolves.toBeDefined();
  });
});
