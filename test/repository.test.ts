import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { TimeloomError } from '../src/errors.js';
import { silentLogger } from '../src/logger.js';
import { STORE_DIRNAME } from '../src/paths.js';
import { Repository, addToProjectGitignore, detectHealthCommand } from '../src/repository.js';
import type { SnapshotRecord, Tree } from '../src/types.js';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const tempDirs: string[] = [];

afterEach(async () => {
  const pending = tempDirs.splice(0, tempDirs.length);
  await Promise.all(
    pending.map((dir) =>
      fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }),
    ),
  );
});

/**
 * A fresh temp directory per call. `realpath` matters on macOS (`/var` is a symlink
 * to `/private/var`) and on Windows (8.3 short names), because `Repository.find` and
 * `RepoPaths.root` both hand back resolved paths that tests compare by string.
 */
async function makeTempDir(): Promise<string> {
  const created = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-repo-'));
  const real = await fs.realpath(created);
  tempDirs.push(real);
  return real;
}

async function writeProjectFile(root: string, repoPath: string, content: string): Promise<void> {
  const absolute = path.join(root, ...repoPath.split('/'));
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, content, 'utf8');
}

async function makeProject(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir();
  for (const [repoPath, content] of Object.entries(files)) {
    await writeProjectFile(root, repoPath, content);
  }
  return root;
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every regular file in the working tree, excluding timeloom's own store, as
 * `repoPath -> hex bytes`. Hex rather than utf8 so a byte-level difference (a lost
 * BOM, a mangled line ending) cannot hide behind a lenient string comparison.
 */
async function readWorkingTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (prefix === '' && entry.name === STORE_DIRNAME) continue;
      const repoPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute, repoPath);
        continue;
      }
      if (!entry.isFile()) continue;
      out[repoPath] = (await fs.readFile(absolute)).toString('hex');
    }
  }

  await walk(root, '');
  return out;
}

async function captureError(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the operation to reject, but it resolved');
}

function expectTimeloomCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TimeloomError);
  expect((error as TimeloomError).code).toBe(code);
}

function countExactLines(text: string, wanted: string): number {
  return text.split(/\r?\n/).filter((line) => line.trim() === wanted).length;
}

/* -------------------------------------------------------------------------- *
 * init
 * -------------------------------------------------------------------------- */

describe('Repository.init', () => {
  it('creates the store, hides it from git, and records a first snapshot of the tree', async () => {
    const root = await makeProject({
      'package.json': '{"name":"demo","version":"1.0.0"}\n',
      'src/index.ts': 'export const version = 1;\n',
      'README.md': '# demo\n',
    });

    const repo = await Repository.init(root);

    expect(await exists(path.join(root, STORE_DIRNAME, 'objects'))).toBe(true);
    expect(await exists(path.join(root, STORE_DIRNAME, 'config.json'))).toBe(true);
    expect(await Repository.isInitialized(root)).toBe(true);

    const snapshots = repo.list();
    expect(snapshots).toHaveLength(1);
    const first = snapshots[0]!;
    expect(first.trigger).toBe('init');
    expect(first.parentId).toBeNull();
    // README.md, package.json, src/index.ts, and the .gitignore init just wrote.
    expect(first.fileCount).toBe(4);
    expect(first.summary.counts).toEqual({ added: 4, modified: 0, deleted: 0 });

    await repo.close();
  });

  it("writes a '*' .gitignore inside the store so the history cannot be committed even without a project .gitignore", async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });

    // updateGitignore: false is the worst case: the project has no .gitignore at all
    // and timeloom was told not to create one. The store must still hide itself.
    const repo = await Repository.init(root, { updateGitignore: false });

    const storeIgnore = await fs.readFile(path.join(root, STORE_DIRNAME, '.gitignore'), 'utf8');
    expect(storeIgnore.split(/\r?\n/).map((line) => line.trim())).toContain('*');
    expect(await exists(path.join(root, '.gitignore'))).toBe(false);

    await repo.close();
  });

  it("appends '.timeloom/' to the project's own .gitignore, preserving what was already there", async () => {
    const root = await makeProject({
      '.gitignore': 'node_modules/\ndist/\n',
      'app.js': 'console.log(1);\n',
    });

    const repo = await Repository.init(root);

    const gitignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    const lines = gitignore.split(/\r?\n/).map((line) => line.trim());
    expect(lines).toContain('node_modules/');
    expect(lines).toContain('dist/');
    expect(countExactLines(gitignore, `${STORE_DIRNAME}/`)).toBe(1);

    await repo.close();
  });

  it('never snapshots its own store, whatever else is in the tree', async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });
    const repo = await Repository.init(root);

    const files = await repo.filesOf(repo.latest()!);
    expect(files.some((entry) => entry.path.startsWith(`${STORE_DIRNAME}/`))).toBe(false);

    await repo.close();
  });

  it('snapshots a .env verbatim — which is precisely why the store must hide itself from git', async () => {
    const root = await makeProject({
      '.env': 'API_KEY=super-secret-value\n',
      'app.js': 'console.log(1);\n',
    });

    const repo = await Repository.init(root, { updateGitignore: false });

    const files = await repo.filesOf(repo.latest()!);
    expect(files.map((entry) => entry.path)).toContain('.env');

    // Adversarial reading of the same fact: the only thing standing between that
    // secret and a public repo is the store's own ignore file.
    const storeIgnore = await fs.readFile(path.join(root, STORE_DIRNAME, '.gitignore'), 'utf8');
    expect(storeIgnore.split(/\r?\n/).map((line) => line.trim())).toContain('*');

    await repo.close();
  });

  it('raises ALREADY_INITIALIZED rather than clobbering an existing store', async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });
    const repo = await Repository.init(root);
    const originalId = repo.latest()!.id;
    await repo.close();

    const error = await captureError(() => Repository.init(root));
    expectTimeloomCode(error, 'ALREADY_INITIALIZED');

    // The failed init must not have touched the history it refused to replace.
    const reopened = await Repository.open(root);
    expect(reopened.list().map((record) => record.id)).toEqual([originalId]);
    await reopened.close();
  });

  it('raises IO when asked to track a directory that does not exist', async () => {
    const parent = await makeTempDir();
    const missing = path.join(parent, 'not-created-yet');

    const error = await captureError(() => Repository.init(missing));
    expectTimeloomCode(error, 'IO');
  });

  it('persists a health command given at init time so a reopened repository still has it', async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });

    const repo = await Repository.init(root, {
      updateGitignore: false,
      healthCommand: 'npm run typecheck',
    });
    expect(repo.config.health.enabled).toBe(true);
    expect(repo.config.health.command).toBe('npm run typecheck');
    await repo.close();

    const reopened = await Repository.open(root);
    expect(reopened.config.health.enabled).toBe(true);
    expect(reopened.config.health.command).toBe('npm run typecheck');
    await reopened.close();
  });
});

/* -------------------------------------------------------------------------- *
 * open / find
 * -------------------------------------------------------------------------- */

describe('Repository.open', () => {
  it('raises NOT_INITIALIZED on a directory that has never been tracked', async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });

    const error = await captureError(() => Repository.open(root));
    expectTimeloomCode(error, 'NOT_INITIALIZED');
  });

  it('replays the index so a second process sees exactly the snapshots the first wrote', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const first = await Repository.init(root, { updateGitignore: false });
    await writeProjectFile(root, 'b.txt', 'bravo\n');
    await first.snapshot({ trigger: 'manual', label: 'second' });
    const expected = first.list();
    await first.close();

    const second = await Repository.open(root);
    expect(second.list()).toEqual(expected);
    expect(second.resolve('second').label).toBe('second');
    await second.close();
  });
});

describe('Repository.find', () => {
  it('walks up from a nested subdirectory and returns the project root', async () => {
    const root = await makeProject({ 'src/deep/nested/file.txt': 'x\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    expect(await Repository.find(path.join(root, 'src', 'deep', 'nested'))).toBe(root);
    expect(await Repository.find(path.join(root, 'src'))).toBe(root);
    expect(await Repository.find(root)).toBe(root);

    await repo.close();
  });

  it('returns null when no ancestor directory is tracked', async () => {
    const root = await makeTempDir();
    const nested = path.join(root, 'a', 'b', 'c');
    await fs.mkdir(nested, { recursive: true });

    expect(await Repository.find(nested)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- *
 * addToProjectGitignore
 * -------------------------------------------------------------------------- */

describe('addToProjectGitignore', () => {
  it('creates the .gitignore when the project has none', async () => {
    const root = await makeTempDir();

    expect(await addToProjectGitignore(root, silentLogger)).toBe(true);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(countExactLines(content, `${STORE_DIRNAME}/`)).toBe(1);
  });

  it('is idempotent: repeated calls never duplicate the entry or change the file', async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n', 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(true);
    const afterFirst = await fs.readFile(path.join(root, '.gitignore'), 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(false);
    expect(await addToProjectGitignore(root, silentLogger)).toBe(false);

    const afterThird = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(afterThird).toBe(afterFirst);
    expect(countExactLines(afterThird, `${STORE_DIRNAME}/`)).toBe(1);
  });

  it('does not glue its entry onto a last line that has no trailing newline', async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, '.gitignore'), 'node_modules', 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(true);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    const lines = content.split(/\r?\n/);
    expect(lines).toContain('node_modules');
    expect(lines).toContain(`${STORE_DIRNAME}/`);
    expect(
      lines.some((line) => line.includes('node_modules') && line.includes(STORE_DIRNAME)),
    ).toBe(false);
  });

  it('treats a bare `.timeloom` entry as already covering the store', async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, '.gitignore'), `# stuff\n${STORE_DIRNAME}\n`, 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(false);

    const content = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
    expect(content).toBe(`# stuff\n${STORE_DIRNAME}\n`);
  });

  it('treats a rooted `/.timeloom/` entry as already covering the store', async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, '.gitignore'), `/${STORE_DIRNAME}/\n`, 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(false);
  });

  it('ignores surrounding whitespace when deciding the entry is already present', async () => {
    const root = await makeTempDir();
    await fs.writeFile(path.join(root, '.gitignore'), `   ${STORE_DIRNAME}/   \n`, 'utf8');

    expect(await addToProjectGitignore(root, silentLogger)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- *
 * snapshot
 * -------------------------------------------------------------------------- */

describe('Repository.snapshot', () => {
  it('returns snapshot: null when the tree is byte-identical to the previous one', async () => {
    const root = await makeProject({
      'app.js': 'console.log(1);\n',
      'lib/util.js': 'export const u = 1;\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const initial = repo.latest()!;

    const outcome = await repo.snapshot({ trigger: 'watch' });

    expect(outcome.snapshot).toBeNull();
    expect(outcome.parent?.id).toBe(initial.id);
    expect(repo.list()).toHaveLength(1);

    await repo.close();
  });

  it('records a snapshot of an unchanged tree anyway when force is set', async () => {
    const root = await makeProject({ 'app.js': 'console.log(1);\n' });
    const repo = await Repository.init(root, { updateGitignore: false });
    const initial = repo.latest()!;

    const outcome = await repo.snapshot({ trigger: 'manual', force: true });

    const forced = outcome.snapshot!;
    expect(forced.id).not.toBe(initial.id);
    expect(forced.treeHash).toBe(initial.treeHash);
    expect(forced.parentId).toBe(initial.id);
    expect(forced.summary.counts).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(forced.summary.kind).toBe('none');
    expect(repo.list()).toHaveLength(2);

    await repo.close();
  });

  it('stores only the changed blob and one new tree when a single file changes', async () => {
    const root = await makeProject({
      'package.json': '{"name":"dedupe-demo"}\n',
      'src/index.ts': 'export const a = 1;\n',
      'src/util/helpers.ts': 'export const helper = () => 1;\n',
      'src/util/format.ts': 'export const format = (s: string) => s.trim();\n',
      'src/components/Button.tsx': 'export const Button = () => null;\n',
      'src/components/Card.tsx': 'export const Card = () => null;\n',
      'src/styles/main.css': 'body { margin: 0; }\n',
      'docs/guide.md': '# guide\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    const before = await repo.objectStore.stats();
    // 8 blobs + 1 tree. If this ever drifts the assertion below stops meaning
    // anything, so pin it.
    expect(before.objectCount).toBe(9);

    await writeProjectFile(root, 'src/util/helpers.ts', 'export const helper = () => 2;\n');
    const outcome = await repo.snapshot({ trigger: 'watch' });
    expect(outcome.snapshot).not.toBeNull();

    const after = await repo.objectStore.stats();
    // One new blob for the edited file, one new tree for the new file list. The
    // other seven files are shared with the previous snapshot, not copied.
    expect(after.objectCount - before.objectCount).toBe(2);
    expect(outcome.snapshot!.fileCount).toBe(8);

    await repo.close();
  });

  it('shares blobs across snapshots, so re-saving a file with its original content costs nothing', async () => {
    const root = await makeProject({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;

    await writeProjectFile(root, 'a.txt', 'ALPHA\n');
    await repo.snapshot({ trigger: 'watch' });
    const afterEdit = await repo.objectStore.stats();

    // Undo the edit by hand. The old blob and the old tree are both still in the
    // store, so this snapshot must add nothing at all.
    await writeProjectFile(root, 'a.txt', 'alpha\n');
    const outcome = await repo.snapshot({ trigger: 'watch' });
    const afterUndo = await repo.objectStore.stats();

    expect(outcome.snapshot!.treeHash).toBe(original.treeHash);
    expect(afterUndo.objectCount).toBe(afterEdit.objectCount);

    await repo.close();
  });

  it('summarises the real diff: counts, scope and kind describe what actually changed', async () => {
    const root = await makeProject({
      'package.json': '{"name":"demo"}\n',
      'src/index.ts': 'export const one = 1;\n',
      'src/styles/main.css': 'body { color: red; }\n',
      'src/styles/theme.css': ':root { --c: blue; }\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    const initial = repo.latest()!;
    expect(initial.summary.counts).toEqual({ added: 4, modified: 0, deleted: 0 });
    // The four files share no common directory and no single kind dominates.
    expect(initial.summary.scope).toBeNull();
    expect(initial.summary.kind).toBe('mixed');

    await writeProjectFile(root, 'src/styles/main.css', 'body { color: green; }\n');
    await writeProjectFile(root, 'src/styles/theme.css', ':root { --c: teal; }\n');

    const record = (await repo.snapshot({ trigger: 'manual', label: 'restyle' })).snapshot!;

    expect(record.summary.counts).toEqual({ added: 0, modified: 2, deleted: 0 });
    expect(record.summary.scope).toBe('src/styles');
    expect(record.summary.kind).toBe('style');
    expect(record.summary.samplePaths).toEqual(['src/styles/main.css', 'src/styles/theme.css']);
    expect(record.label).toBe('restyle');
    expect(record.parentId).toBe(initial.id);
    expect(record.fileCount).toBe(4);

    await repo.close();
  });

  it('reports added, modified and deleted files together in one summary', async () => {
    const root = await makeProject({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
      'c.txt': 'charlie\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    await writeProjectFile(root, 'b.txt', 'bravo!\n');
    await writeProjectFile(root, 'd.txt', 'delta\n');
    await fs.rm(path.join(root, 'c.txt'));

    const record = (await repo.snapshot({ trigger: 'watch' })).snapshot!;

    expect(record.summary.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
    // Modified sorts ahead of added, which sorts ahead of deleted.
    expect(record.summary.samplePaths).toEqual(['b.txt', 'd.txt', 'c.txt']);

    await repo.close();
  });

  it('notifies registered listeners of every snapshot it records, and stops after unsubscribe', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    const seen: string[] = [];
    const unsubscribe = repo.on((event) => {
      if (event.type === 'snapshot') seen.push(event.snapshot.id);
    });

    const first = (await repo.snapshot({ trigger: 'manual', force: true })).snapshot!;
    expect(seen).toEqual([first.id]);

    unsubscribe();
    await repo.snapshot({ trigger: 'manual', force: true });
    expect(seen).toEqual([first.id]);

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * ignore rules
 * -------------------------------------------------------------------------- */

describe('Repository.refreshIgnoreRules', () => {
  it('picks up an edited .gitignore, so a newly ignored file stops being snapshotted', async () => {
    const root = await makeProject({
      '.gitignore': 'build-output.txt\n',
      'build-output.txt': 'generated\n',
      'secret.txt': 'token=abc\n',
      'app.js': 'console.log(1);\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    const tracked = (await repo.filesOf(repo.latest()!)).map((entry) => entry.path);
    expect(tracked).toEqual(['.gitignore', 'app.js', 'secret.txt']);

    // The matcher is held for the repository's lifetime, so an edit needs an explicit
    // refresh — that is what this method exists for.
    await writeProjectFile(root, '.gitignore', 'build-output.txt\nsecret.txt\n');
    repo.refreshIgnoreRules();

    const record = (await repo.snapshot({ trigger: 'manual' })).snapshot!;
    expect((await repo.filesOf(record)).map((entry) => entry.path)).toEqual([
      '.gitignore',
      'app.js',
    ]);
    expect(record.summary.counts).toEqual({ added: 0, modified: 1, deleted: 1 });

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * diff
 * -------------------------------------------------------------------------- */

describe('Repository.diff', () => {
  it('compares a snapshot against the working tree when `to` is null', async () => {
    const root = await makeProject({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
      'c.txt': 'charlie\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const initial = repo.latest()!;

    await writeProjectFile(root, 'b.txt', 'bravo!\n');
    await writeProjectFile(root, 'd.txt', 'delta\n');
    await fs.rm(path.join(root, 'c.txt'));

    const result = await repo.diff('latest', null);

    expect(result.fromId).toBe(initial.id);
    expect(result.toId).toBeNull();
    expect(result.counts).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(result.changes.map((change) => [change.path, change.status])).toEqual([
      ['b.txt', 'modified'],
      ['c.txt', 'deleted'],
      ['d.txt', 'added'],
    ]);
    // Nothing was written: diffing against disk is a read-only operation.
    expect(repo.list()).toHaveLength(1);

    await repo.close();
  });

  it('reports no changes when the working tree still matches the latest snapshot', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    const result = await repo.diff('latest', null);

    expect(result.changes).toEqual([]);
    expect(result.counts).toEqual({ added: 0, modified: 0, deleted: 0 });

    await repo.close();
  });

  it('compares two snapshots to each other when both references are given', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });
    const first = repo.latest()!;

    await writeProjectFile(root, 'a.txt', 'ALPHA\n');
    const second = (await repo.snapshot({ trigger: 'manual' })).snapshot!;

    const forward = await repo.diff(first.id, second.id);
    expect(forward.counts).toEqual({ added: 0, modified: 1, deleted: 0 });

    // Reversing the arguments reverses the verdict; nothing is order-dependent.
    const backward = await repo.diff(second.id, first.id);
    expect(backward.counts).toEqual({ added: 0, modified: 1, deleted: 0 });
    expect(backward.changes[0]!.hashAfter).toBe(forward.changes[0]!.hashBefore);

    await repo.close();
  });

  it('raises SNAPSHOT_NOT_FOUND for a reference that matches nothing', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    const error = await captureError(() => repo.diff('deadbeef', null));
    expectTimeloomCode(error, 'SNAPSHOT_NOT_FOUND');

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * restore
 * -------------------------------------------------------------------------- */

describe('Repository.restore', () => {
  it('puts the tree back byte for byte after an edit, an addition and a whole deleted directory', async () => {
    const root = await makeProject({
      'package.json': '{"name":"demo","version":"1.0.0"}\n',
      'src/index.ts': 'export const version = 1;\n',
      'src/util/helpers.ts': 'export const helper = () => 1;\n',
      'src/components/Button.tsx': 'export const Button = () => null;\n',
      'src/styles/main.css': 'body { margin: 0; }\n',
      'legacy/old-a.txt': 'ancient a\n',
      'legacy/old-b.txt': 'ancient b\n',
      'legacy/nested/old-c.txt': 'ancient c\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const snapshotA = repo.latest()!;
    const treeA = await readWorkingTree(root);

    await writeProjectFile(
      root,
      'src/index.ts',
      'export const version = 2;\nexport const extra = true;\n',
    );
    await writeProjectFile(root, 'src/feature/new.ts', 'export const feature = "new";\n');
    await fs.rm(path.join(root, 'legacy'), { recursive: true, force: true });

    const snapshotB = (await repo.snapshot({ trigger: 'manual' })).snapshot!;
    expect(snapshotB.fileCount).toBe(6);
    expect(await readWorkingTree(root)).not.toEqual(treeA);

    const result = await repo.restore(snapshotA.id);

    // src/index.ts reverted, plus the three legacy files brought back.
    expect(result.written).toBe(4);
    // src/feature/new.ts did not exist in A, so restoring A removes it.
    expect(result.deleted).toBe(1);
    expect(result.targetId).toBe(snapshotA.id);

    expect(await readWorkingTree(root)).toEqual(treeA);
    // The directory that held the only removed file is cleaned up rather than left
    // behind as an empty skeleton.
    expect(await exists(path.join(root, 'src', 'feature'))).toBe(false);
    // Its non-empty parent is untouched.
    expect(await exists(path.join(root, 'src'))).toBe(true);

    await repo.close();
  });

  it('takes a safety snapshot first, and restoring that safety snapshot undoes the restore', async () => {
    const root = await makeProject({
      'app.js': 'console.log("v1");\n',
      'lib/util.js': 'export const u = 1;\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;
    const treeV1 = await readWorkingTree(root);

    // Deliberately do NOT snapshot: the safety snapshot is the only thing standing
    // between this work and oblivion.
    await writeProjectFile(root, 'app.js', 'console.log("v2");\n');
    await writeProjectFile(root, 'lib/extra.js', 'export const e = 2;\n');
    await fs.rm(path.join(root, 'lib', 'util.js'));
    const treeV2 = await readWorkingTree(root);

    const result = await repo.restore(original.id);

    expect(result.safetySnapshotId).not.toBeNull();
    const safety = repo.get(result.safetySnapshotId!)!;
    expect(safety.trigger).toBe('pre-restore');
    expect(safety.id).not.toBe(original.id);
    expect(await readWorkingTree(root)).toEqual(treeV1);

    // Undo of the undo — the thing a panicking user reaches for.
    await repo.restore(safety.id);
    expect(await readWorkingTree(root)).toEqual(treeV2);

    await repo.close();
  });

  it('skips the safety snapshot on a dry run and leaves the working tree untouched', async () => {
    const root = await makeProject({ 'app.js': 'console.log("v1");\n' });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;

    await writeProjectFile(root, 'app.js', 'console.log("v2");\n');
    const treeV2 = await readWorkingTree(root);
    const snapshotsBefore = repo.list().length;

    const result = await repo.restore(original.id, { dryRun: true });

    expect(result.safetySnapshotId).toBeNull();
    expect(result.written).toBe(1);
    expect(await readWorkingTree(root)).toEqual(treeV2);
    expect(repo.list()).toHaveLength(snapshotsBefore);

    await repo.close();
  });

  it('leaves latest() describing what is on disk, so the next automatic snapshot reports nothing', async () => {
    const root = await makeProject({
      'app.js': 'console.log("v1");\n',
      'lib/util.js': 'export const u = 1;\n',
      'docs/guide.md': '# guide\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;

    await writeProjectFile(root, 'app.js', 'console.log("v2");\n');
    await writeProjectFile(root, 'lib/extra.js', 'export const e = 2;\n');
    await repo.snapshot({ trigger: 'manual' });

    await repo.restore(original.id);

    const landed = repo.latest()!;
    expect(landed.trigger).toBe('restore');
    expect(landed.id).not.toBe(original.id);
    expect(landed.treeHash).toBe(original.treeHash);
    expect(landed.fileCount).toBe(original.fileCount);

    // The whole point: the watcher's next pass must not see a huge fake diff.
    const next = await repo.snapshot({ trigger: 'watch' });
    expect(next.snapshot).toBeNull();

    const status = await repo.status();
    expect(status.pendingChanges).toEqual({ added: 0, modified: 0, deleted: 0 });

    await repo.close();
  });

  it('carries the target snapshot’s health verdict onto the restore record, because the bytes are identical', async () => {
    const root = await makeProject({ 'app.js': 'console.log("v1");\n' });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;

    await repo.update(original.id, {
      health: {
        status: 'healthy',
        command: 'npm run typecheck',
        exitCode: 0,
        durationMs: 12,
        checkedAt: new Date().toISOString(),
        outputTail: '',
      },
    });

    await writeProjectFile(root, 'app.js', 'console.log("broken");\n');
    await repo.restore(original.id);

    const landed = repo.latest()!;
    expect(landed.health?.status).toBe('healthy');
    // `restore healthy` must therefore find the state that is actually on disk.
    expect(repo.lastHealthy()?.id).toBe(landed.id);

    await repo.close();
  });

  it('plans a restore without touching anything, reporting the same blast radius it would apply', async () => {
    const root = await makeProject({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });
    const original = repo.latest()!;

    await writeProjectFile(root, 'a.txt', 'ALPHA\n');
    await writeProjectFile(root, 'c.txt', 'charlie\n');
    const treeBefore = await readWorkingTree(root);

    const plan = await repo.planRestore(original.id);

    expect(plan.targetId).toBe(original.id);
    expect(plan.write.map((item) => item.entry.path)).toEqual(['a.txt']);
    expect(plan.delete.map((change) => change.path)).toEqual(['c.txt']);
    expect(await readWorkingTree(root)).toEqual(treeBefore);

    await repo.close();
  });

  it('raises SNAPSHOT_NOT_FOUND for an unknown reference instead of mangling the tree', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });
    const treeBefore = await readWorkingTree(root);

    const error = await captureError(() => repo.restore('no-such-snapshot'));
    expectTimeloomCode(error, 'SNAPSHOT_NOT_FOUND');
    expect(await readWorkingTree(root)).toEqual(treeBefore);

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * restore, treated as a consumer of untrusted data
 * -------------------------------------------------------------------------- */

describe('Repository.restore, given a hostile store', () => {
  /**
   * Forge a snapshot whose tree names `maliciousPath`, wire it into the index by
   * hand, and hand the repository back. This is exactly the shape of an attack where
   * someone ships a project with a `.timeloom` directory already in it: the store is
   * data, and data must never be able to write outside the project.
   */
  async function plantMaliciousSnapshot(
    repo: Repository,
    root: string,
    id: string,
    maliciousPath: string,
  ): Promise<void> {
    const payload = Buffer.from('pwned\n', 'utf8');
    const { hash } = await repo.objectStore.put(payload);
    const tree: Tree = {
      v: 1,
      files: [{ path: maliciousPath, hash, size: payload.byteLength, executable: false }],
    };
    const { hash: treeHash } = await repo.objectStore.putJson(tree);

    const record: SnapshotRecord = {
      id,
      seq: 900 + id.length,
      createdAt: new Date().toISOString(),
      treeHash,
      parentId: null,
      fileCount: 1,
      totalBytes: payload.byteLength,
      trigger: 'manual',
      label: null,
      pinned: false,
      summary: {
        counts: { added: 1, modified: 0, deleted: 0 },
        samplePaths: [maliciousPath],
        scope: null,
        kind: 'mixed',
      },
      health: null,
    };

    await fs.appendFile(
      path.join(root, STORE_DIRNAME, 'index.jsonl'),
      `${JSON.stringify({ t: 'add', s: record })}\n`,
      'utf8',
    );
  }

  it('refuses a snapshot entry that traverses out of the project and writes nothing outside it', async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, 'project');
    await fs.mkdir(root);
    await writeProjectFile(root, 'app.js', 'console.log(1);\n');

    const repo = await Repository.init(root, { updateGitignore: false });
    await plantMaliciousSnapshot(repo, root, 'traversal', '../escape.txt');
    await repo.close();

    const reopened = await Repository.open(root);
    const error = await captureError(() => reopened.restore('traversal'));

    expectTimeloomCode(error, 'PATH_ESCAPE');
    expect(await exists(path.join(parent, 'escape.txt'))).toBe(false);

    await reopened.close();
  });

  it('refuses a snapshot entry holding an absolute path', async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, 'project');
    await fs.mkdir(root);
    await writeProjectFile(root, 'app.js', 'console.log(1);\n');

    const repo = await Repository.init(root, { updateGitignore: false });
    // POSIX-rooted on purpose: `path.isAbsolute` catches it on both platforms.
    await plantMaliciousSnapshot(repo, root, 'absolute', '/tmp/timeloom-escape.txt');
    await repo.close();

    const reopened = await Repository.open(root);
    const error = await captureError(() => reopened.restore('absolute'));

    expectTimeloomCode(error, 'PATH_ESCAPE');

    await reopened.close();
  });

  // Symlinks need Developer Mode or an elevated shell on Windows, so creating the
  // fixture is not reliable there. The guard being tested is platform-independent.
  describe.skipIf(process.platform === 'win32')('when a tracked path has become a symlink', () => {
    it('does not write through it, leaving the link and its target alone', async () => {
      const parent = await makeTempDir();
      const root = path.join(parent, 'project');
      await fs.mkdir(root);
      await writeProjectFile(root, 'app.js', 'console.log(1);\n');
      await writeProjectFile(root, 'data/config.json', '{"mode":"safe"}\n');

      const outside = path.join(parent, 'outside.json');
      await fs.writeFile(outside, '{"owner":"someone-else"}\n', 'utf8');

      const repo = await Repository.init(root, { updateGitignore: false });
      const original = repo.latest()!;

      // Swap the tracked file for a link pointing outside the project.
      const tracked = path.join(root, 'data', 'config.json');
      await fs.rm(tracked);
      await fs.symlink(outside, tracked);

      const result = await repo.restore(original.id);

      expect(result.written).toBe(0);
      expect((await fs.lstat(tracked)).isSymbolicLink()).toBe(true);
      expect(await fs.readFile(outside, 'utf8')).toBe('{"owner":"someone-else"}\n');

      await repo.close();
    });
  });
});

/* -------------------------------------------------------------------------- *
 * concurrency
 * -------------------------------------------------------------------------- */

describe('Repository locking', () => {
  it('serialises overlapping snapshots so every record gets a distinct id and sequence', async () => {
    const root = await makeProject({
      'a.txt': 'alpha\n',
      'b.txt': 'bravo\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    const [first, second] = await Promise.all([
      repo.snapshot({ trigger: 'manual', force: true }),
      repo.snapshot({ trigger: 'manual', force: true }),
    ]);

    const one = first.snapshot!;
    const two = second.snapshot!;
    expect(one.id).not.toBe(two.id);
    expect(one.seq).not.toBe(two.seq);

    const records = repo.list();
    expect(records).toHaveLength(3);
    expect(new Set(records.map((record) => record.id)).size).toBe(3);
    expect(new Set(records.map((record) => record.seq)).size).toBe(3);
    // The log survived the overlap: a reopened repository replays the same history.
    await repo.close();
    const reopened = await Repository.open(root);
    expect(reopened.list().map((record) => record.seq)).toEqual(records.map((r) => r.seq));
    await reopened.close();
  });

  it('releases the lock after a failed operation, so the next one still works', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    const error = await captureError(() => repo.restore('does-not-exist'));
    expectTimeloomCode(error, 'SNAPSHOT_NOT_FOUND');

    await writeProjectFile(root, 'a.txt', 'ALPHA\n');
    const outcome = await repo.snapshot({ trigger: 'manual' });
    expect(outcome.snapshot).not.toBeNull();

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * status
 * -------------------------------------------------------------------------- */

describe('Repository.status', () => {
  it('reports pending changes after an out-of-band edit', async () => {
    const root = await makeProject({
      'src/index.ts': 'export const one = 1;\n',
      'notes.md': '# notes\n',
    });
    const repo = await Repository.init(root, { updateGitignore: false });

    const clean = await repo.status();
    expect(clean.initialized).toBe(true);
    expect(clean.root).toBe(root);
    expect(clean.snapshotCount).toBe(1);
    expect(clean.daemon).toBeNull();
    expect(clean.pendingChanges).toEqual({ added: 0, modified: 0, deleted: 0 });
    expect(clean.objectCount).toBeGreaterThan(0);
    expect(clean.storeBytes).toBeGreaterThan(0);

    // Edits made by an editor, a formatter, or an AI agent — nobody told timeloom.
    await writeProjectFile(root, 'src/index.ts', 'export const one = 2;\n');
    await writeProjectFile(root, 'src/extra.ts', 'export const extra = true;\n');
    await fs.rm(path.join(root, 'notes.md'));

    const dirty = await repo.status();
    expect(dirty.pendingChanges).toEqual({ added: 1, modified: 1, deleted: 1 });
    expect(dirty.snapshotCount).toBe(1);
    expect(dirty.latest?.id).toBe(repo.latest()!.id);

    await repo.close();
  });

  it('reports no known-healthy snapshot until a health verdict says otherwise', async () => {
    const root = await makeProject({ 'a.txt': 'alpha\n' });
    const repo = await Repository.init(root, { updateGitignore: false });

    expect((await repo.status()).lastHealthy).toBeNull();

    await repo.update(repo.latest()!.id, {
      health: {
        status: 'healthy',
        command: 'npm test',
        exitCode: 0,
        durationMs: 5,
        checkedAt: new Date().toISOString(),
        outputTail: '',
      },
    });

    expect((await repo.status()).lastHealthy?.id).toBe(repo.latest()!.id);

    await repo.close();
  });
});

/* -------------------------------------------------------------------------- *
 * detectHealthCommand
 * -------------------------------------------------------------------------- */

describe('detectHealthCommand', () => {
  it('prefers `npm run typecheck` over `npm run build` when a project has both', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({
        name: 'demo',
        scripts: { build: 'tsc -p .', typecheck: 'tsc --noEmit', lint: 'eslint .' },
      }),
    });

    expect(await detectHealthCommand(root)).toBe('npm run typecheck');
  });

  it('walks the script preference order down to build, compile and lint', async () => {
    const withBuild = await makeProject({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', build: 'tsc -p .' } }),
    });
    expect(await detectHealthCommand(withBuild)).toBe('npm run build');

    const withCompile = await makeProject({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .', compile: 'tsc -p .' } }),
    });
    expect(await detectHealthCommand(withCompile)).toBe('npm run compile');

    const withLint = await makeProject({
      'package.json': JSON.stringify({ scripts: { lint: 'eslint .' } }),
    });
    expect(await detectHealthCommand(withLint)).toBe('npm run lint');
  });

  it('refuses to guess from scripts whose failure would not mean broken code', async () => {
    // `test`, `start` and `dev` all fail for reasons that have nothing to do with the
    // code being correct. A wrong guess makes every snapshot look broken.
    const root = await makeProject({
      'package.json': JSON.stringify({ scripts: { test: 'vitest', start: 'node .', dev: 'vite' } }),
    });

    expect(await detectHealthCommand(root)).toBeNull();
  });

  it('prefers a package.json script over a bare tsconfig.json', async () => {
    const root = await makeProject({
      'package.json': JSON.stringify({ scripts: { typecheck: 'tsc --noEmit' } }),
      'tsconfig.json': '{}',
    });

    expect(await detectHealthCommand(root)).toBe('npm run typecheck');
  });

  it('falls back through tsconfig.json, pyproject.toml, Cargo.toml and go.mod', async () => {
    const typescript = await makeProject({ 'tsconfig.json': '{"compilerOptions":{}}' });
    expect(await detectHealthCommand(typescript)).toBe('npx tsc --noEmit');

    const python = await makeProject({ 'pyproject.toml': '[project]\nname = "demo"\n' });
    expect(await detectHealthCommand(python)).toBe('python -m compileall -q .');

    const rust = await makeProject({ 'Cargo.toml': '[package]\nname = "demo"\n' });
    expect(await detectHealthCommand(rust)).toBe('cargo check');

    const go = await makeProject({ 'go.mod': 'module demo\n\ngo 1.22\n' });
    expect(await detectHealthCommand(go)).toBe('go build ./...');
  });

  it('returns null for an empty directory rather than guessing', async () => {
    const root = await makeTempDir();

    expect(await detectHealthCommand(root)).toBeNull();
  });

  it('reads a package.json that carries a UTF-8 byte order mark', async () => {
    // PowerShell's `Set-Content -Encoding utf8` and several Windows editors emit one
    // by default; JSON.parse rejects it outright, so it must be stripped first.
    const bom = String.fromCharCode(0xfeff);
    const root = await makeTempDir();
    await fs.writeFile(
      path.join(root, 'package.json'),
      bom + JSON.stringify({ name: 'demo', scripts: { typecheck: 'tsc --noEmit' } }),
      'utf8',
    );

    // Guard the fixture itself: if the BOM is not really on disk the test proves nothing.
    const raw = await fs.readFile(path.join(root, 'package.json'));
    expect([raw[0], raw[1], raw[2]]).toEqual([0xef, 0xbb, 0xbf]);

    expect(await detectHealthCommand(root)).toBe('npm run typecheck');
  });

  it('falls through to the next marker when package.json is unparseable', async () => {
    const root = await makeProject({
      'package.json': '{ this is not json',
      'Cargo.toml': '[package]\nname = "demo"\n',
    });

    expect(await detectHealthCommand(root)).toBe('cargo check');
  });

  it('tolerates a package.json with no scripts block at all', async () => {
    const root = await makeProject({ 'package.json': JSON.stringify({ name: 'demo' }) });

    expect(await detectHealthCommand(root)).toBeNull();
  });
});
