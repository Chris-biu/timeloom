import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  LANGUAGES,
  defaultConfig,
  isLoopbackHost,
  parseConfig,
  type Language,
} from '../src/config.js';
import {
  displayWidth,
  padEnd,
  renderTable,
  stripAnsi,
  truncate,
  type Column,
} from '../src/cli/ui.js';
import { classifyPath, commonDirectory, dominantKind } from '../src/core/classify.js';
import { formatSummary, summarizeChanges } from '../src/core/describe.js';
import { countChanges, diffFileLists, totalChanges } from '../src/core/diff.js';
import { catalog } from '../src/i18n.js';
import {
  SNAPSHOT_TRIGGERS,
  type ChangeCounts,
  type ChangeKind,
  type FileChange,
  type FileChangeStatus,
  type FileEntry,
  type HealthStatus,
} from '../src/types.js';
import { formatBytes, fromRepoPath, stripBom, toRepoPath } from '../src/util/fsx.js';
import { ValidationError } from '../src/util/validate.js';

/**
 * Everything under test in this file is pure: no filesystem, no clock, no process
 * state. That is deliberate on the source side and it means these tests need no temp
 * directories and are trivially safe to run in parallel.
 *
 * The one piece of ambient state that leaks in is `process.stdout.isTTY`, which
 * decides whether `src/cli/ui.ts` emits ANSI colour. Every assertion about rendered
 * text therefore goes through `stripAnsi` first, so the suite behaves identically
 * under a TTY, under CI, and under `FORCE_COLOR=1`.
 */

/** ESC built from its code point — see the same comment in src/cli/ui.ts. */
const ESC = String.fromCharCode(27);
const BOM = String.fromCharCode(0xfeff);

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function entry(filePath: string, hash: string, size = 10, executable = false): FileEntry {
  return { path: filePath, hash, size, executable };
}

function change(filePath: string, status: FileChangeStatus): FileChange {
  return {
    path: filePath,
    status,
    sizeBefore: status === 'added' ? null : 1,
    sizeAfter: status === 'deleted' ? null : 2,
    hashBefore: status === 'added' ? null : 'a',
    hashAfter: status === 'deleted' ? null : 'b',
  };
}

function counts(modified: number, added: number, deleted: number): ChangeCounts {
  return { modified, added, deleted };
}

/**
 * Compile-time exhaustive maps over the two unions that have no exported runtime
 * array. `Record<ChangeKind, true>` cannot be written without naming every variant,
 * so adding a `ChangeKind` breaks the typecheck here, and the derived array below
 * then also breaks the "every variant has a label" test at runtime.
 */
const CHANGE_KIND_PRESENCE: Record<ChangeKind, true> = {
  none: true,
  ui: true,
  style: true,
  logic: true,
  config: true,
  deps: true,
  docs: true,
  test: true,
  assets: true,
  mixed: true,
};
const CHANGE_KINDS = Object.keys(CHANGE_KIND_PRESENCE) as ChangeKind[];

const HEALTH_STATUS_PRESENCE: Record<HealthStatus, true> = {
  healthy: true,
  broken: true,
  timeout: true,
  error: true,
  skipped: true,
};
const HEALTH_STATUSES = Object.keys(HEALTH_STATUS_PRESENCE) as HealthStatus[];

// ---------------------------------------------------------------------------
// src/core/diff.ts
// ---------------------------------------------------------------------------

describe('diffFileLists', () => {
  it('reports a path present only in the new list as added, with no "before" data', () => {
    const changes = diffFileLists([], [entry('src/a.ts', 'h1', 42)]);
    expect(changes).toEqual([
      {
        path: 'src/a.ts',
        status: 'added',
        sizeBefore: null,
        sizeAfter: 42,
        hashBefore: null,
        hashAfter: 'h1',
      },
    ]);
  });

  it('reports a path present only in the old list as deleted, with no "after" data', () => {
    const changes = diffFileLists([entry('src/a.ts', 'h1', 42)], []);
    expect(changes).toEqual([
      {
        path: 'src/a.ts',
        status: 'deleted',
        sizeBefore: 42,
        sizeAfter: null,
        hashBefore: 'h1',
        hashAfter: null,
      },
    ]);
  });

  it('reports a path whose hash changed as modified, carrying both hashes and both sizes', () => {
    const changes = diffFileLists([entry('a.ts', 'h1', 10)], [entry('a.ts', 'h2', 20)]);
    expect(changes).toEqual([
      {
        path: 'a.ts',
        status: 'modified',
        sizeBefore: 10,
        sizeAfter: 20,
        hashBefore: 'h1',
        hashAfter: 'h2',
      },
    ]);
  });

  it('reports nothing for a file whose hash and executable bit are both unchanged', () => {
    const before = [entry('a.ts', 'h1', 10, true), entry('b.ts', 'h2', 20, false)];
    const after = [entry('a.ts', 'h1', 10, true), entry('b.ts', 'h2', 20, false)];
    expect(diffFileLists(before, after)).toEqual([]);
  });

  it('counts gaining the executable bit as a modification even though the hash is identical', () => {
    const changes = diffFileLists(
      [entry('deploy.sh', 'same', 100, false)],
      [entry('deploy.sh', 'same', 100, true)],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
    // The whole point: content did not move, so the diff record shows equal hashes.
    expect(changes[0]!.hashBefore).toBe('same');
    expect(changes[0]!.hashAfter).toBe('same');
  });

  it('counts losing the executable bit as a modification too, since -x breaks a script', () => {
    const changes = diffFileLists(
      [entry('deploy.sh', 'same', 100, true)],
      [entry('deploy.sh', 'same', 100, false)],
    );
    expect(changes).toHaveLength(1);
    expect(changes[0]!.status).toBe('modified');
  });

  it('returns changes sorted by path regardless of the order of either input list', () => {
    const before = [entry('z.ts', 'h'), entry('m.ts', 'h'), entry('a.ts', 'h')];
    const after = [entry('m.ts', 'h2'), entry('b.ts', 'h'), entry('a.ts', 'h')];
    const changes = diffFileLists(before, after);
    expect(changes.map((c) => c.path)).toEqual(['b.ts', 'm.ts', 'z.ts']);
  });

  it('sorts by code-unit order, not locale order, so the ordering is host-independent', () => {
    const after = [entry('b.ts', 'h'), entry('B.ts', 'h'), entry('a.ts', 'h'), entry('A.ts', 'h')];
    const paths = diffFileLists([], after).map((c) => c.path);
    expect(paths).toEqual([...paths].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)));
    // Uppercase sorts first under code-unit comparison; a locale-aware sort would not.
    expect(paths).toEqual(['A.ts', 'B.ts', 'a.ts', 'b.ts']);
  });

  it('interleaves added, modified and deleted entries in one path-sorted list', () => {
    const before = [entry('a.ts', 'h1'), entry('c.ts', 'h1')];
    const after = [entry('a.ts', 'h2'), entry('b.ts', 'h1')];
    expect(diffFileLists(before, after).map((c) => [c.path, c.status])).toEqual([
      ['a.ts', 'modified'],
      ['b.ts', 'added'],
      ['c.ts', 'deleted'],
    ]);
  });

  it('returns an empty list when both inputs are empty', () => {
    expect(diffFileLists([], [])).toEqual([]);
  });

  it('does not mutate either input list', () => {
    const before = [entry('z.ts', 'h'), entry('a.ts', 'h')];
    const after = [entry('a.ts', 'h2')];
    const beforeCopy = structuredClone(before);
    const afterCopy = structuredClone(after);
    diffFileLists(before, after);
    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });

  it('round-trips: diffing a list against itself is empty, and against empty is all-added', () => {
    const files = [entry('a.ts', 'h1'), entry('src/b.ts', 'h2', 3, true)];
    expect(diffFileLists(files, files)).toEqual([]);
    const added = diffFileLists([], files);
    expect(added.every((c) => c.status === 'added')).toBe(true);
    expect(added).toHaveLength(files.length);
  });
});

describe('countChanges', () => {
  it('tallies each status independently and starts every bucket at zero', () => {
    expect(countChanges([])).toEqual({ added: 0, modified: 0, deleted: 0 });
  });

  it('counts one entry per change, matching the length of the input', () => {
    const changes = [
      change('a', 'added'),
      change('b', 'added'),
      change('c', 'modified'),
      change('d', 'deleted'),
      change('e', 'deleted'),
      change('f', 'deleted'),
    ];
    expect(countChanges(changes)).toEqual({ added: 2, modified: 1, deleted: 3 });
    expect(totalChanges(countChanges(changes))).toBe(changes.length);
  });
});

describe('totalChanges', () => {
  it('sums the three buckets', () => {
    expect(totalChanges(counts(1, 2, 3))).toBe(6);
  });

  it('is zero for an all-zero count, which is how callers detect "nothing happened"', () => {
    expect(totalChanges(counts(0, 0, 0))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// src/core/classify.ts
// ---------------------------------------------------------------------------

describe('classifyPath', () => {
  it('classifies a JavaScript and a Python manifest as dependency changes', () => {
    expect(classifyPath('package.json')).toBe('deps');
    expect(classifyPath('requirements.txt')).toBe('deps');
  });

  it('classifies lockfiles and nested manifests as dependency changes', () => {
    expect(classifyPath('pnpm-lock.yaml')).toBe('deps');
    expect(classifyPath('packages/api/package.json')).toBe('deps');
    expect(classifyPath('Cargo.toml')).toBe('deps');
  });

  it('classifies a `.test.` filename and anything under a tests directory as tests', () => {
    expect(classifyPath('src/foo.test.ts')).toBe('test');
    expect(classifyPath('tests/x.py')).toBe('test');
  });

  it('recognises the language-specific test conventions Go, Python and Ruby use', () => {
    expect(classifyPath('pkg/thing_test.go')).toBe('test');
    expect(classifyPath('app/test_thing.py')).toBe('test');
    expect(classifyPath('lib/thing_test.rb')).toBe('test');
    expect(classifyPath('src/foo.spec.ts')).toBe('test');
  });

  it('classifies markdown and anything under docs as documentation', () => {
    expect(classifyPath('README.md')).toBe('docs');
    expect(classifyPath('docs/x')).toBe('docs');
    expect(classifyPath('LICENSE')).toBe('docs');
  });

  it('classifies stylesheets and a tailwind config as styling', () => {
    expect(classifyPath('src/app.css')).toBe('style');
    expect(classifyPath('src/app.scss')).toBe('style');
    expect(classifyPath('tailwind.config.js')).toBe('style');
  });

  it('classifies images, fonts and vector art as assets', () => {
    expect(classifyPath('public/logo.png')).toBe('assets');
    expect(classifyPath('public/fonts/inter.woff2')).toBe('assets');
    expect(classifyPath('public/icon.svg')).toBe('assets');
  });

  it('classifies dotfiles, tsconfig, tool configs and CI workflows as config', () => {
    expect(classifyPath('.env')).toBe('config');
    expect(classifyPath('.env.local')).toBe('config');
    expect(classifyPath('tsconfig.json')).toBe('config');
    expect(classifyPath('vite.config.ts')).toBe('config');
    expect(classifyPath('.github/workflows/ci.yml')).toBe('config');
    expect(classifyPath('Dockerfile')).toBe('config');
  });

  it('classifies component-shaped files and code under a UI directory as UI', () => {
    expect(classifyPath('src/App.tsx')).toBe('ui');
    expect(classifyPath('src/App.vue')).toBe('ui');
    expect(classifyPath('src/components/x.ts')).toBe('ui');
    expect(classifyPath('app/pages/index.js')).toBe('ui');
  });

  it('classifies plain source outside a UI directory as logic', () => {
    expect(classifyPath('src/lib/auth.ts')).toBe('logic');
    expect(classifyPath('server/main.go')).toBe('logic');
    expect(classifyPath('scripts/deploy.sh')).toBe('logic');
  });

  it('returns null for a path it cannot place, so it abstains instead of guessing', () => {
    expect(classifyPath('data/blob.xyz')).toBeNull();
    expect(classifyPath('notes')).toBeNull();
    expect(classifyPath('')).toBeNull();
  });

  it('treats a leading dot as part of the name, not an extension separator', () => {
    // `.env` must not be read as "extension .env"; the config branch owns it.
    expect(classifyPath('.env')).toBe('config');
    // `.gitignore` is a known config filename rather than an extension match.
    expect(classifyPath('.gitignore')).toBe('config');
  });

  it('is case-insensitive, so README.MD and readme.md classify the same', () => {
    expect(classifyPath('README.MD')).toBe(classifyPath('readme.md'));
    expect(classifyPath('Package.JSON')).toBe('deps');
    expect(classifyPath('Makefile')).toBe('config');
  });

  describe('precedence between overlapping rules', () => {
    it('ranks test above UI: src/components/Button.test.tsx is a test, not UI', () => {
      expect(classifyPath('src/components/Button.test.tsx')).toBe('test');
    });

    it('ranks deps above test: a package.json inside tests/ is still a dependency change', () => {
      expect(classifyPath('tests/fixtures/package.json')).toBe('deps');
    });

    it('ranks test above docs: a markdown file under tests/ is a test fixture', () => {
      expect(classifyPath('tests/cases/readme.md')).toBe('test');
    });

    it('ranks style above config: tailwind.config.js is styling, not tooling', () => {
      expect(classifyPath('tailwind.config.js')).toBe('style');
      // …while the sibling generic pattern still lands in config.
      expect(classifyPath('vitest.config.js')).toBe('config');
    });

    it('ranks docs above assets: docs/diagram.svg is documentation', () => {
      expect(classifyPath('docs/diagram.svg')).toBe('docs');
    });

    it('ranks UI-by-directory above logic for otherwise identical extensions', () => {
      expect(classifyPath('src/components/helper.ts')).toBe('ui');
      expect(classifyPath('src/helpers/helper.ts')).toBe('logic');
    });
  });
});

describe('dominantKind', () => {
  it('returns "none" for an empty set, distinguishing "nothing changed" from "unclear"', () => {
    expect(dominantKind([])).toBe('none');
  });

  it('names the kind when a clear majority of paths agree', () => {
    expect(dominantKind(['src/a.css', 'src/b.css', 'src/c.scss', 'src/lib/auth.ts'])).toBe('style');
  });

  it('returns the kind when every path agrees', () => {
    expect(dominantKind(['src/lib/a.ts', 'src/lib/b.ts'])).toBe('logic');
  });

  it('returns "mixed" when the set is scattered across kinds with no clear winner', () => {
    expect(dominantKind(['src/a.css', 'src/lib/auth.ts', 'README.md', 'package.json'])).toBe(
      'mixed',
    );
  });

  it('returns "mixed" at a bare plurality, refusing to label a 50/50 split', () => {
    expect(dominantKind(['a.css', 'b.css', 'src/lib/x.ts', 'src/lib/y.ts'])).toBe('mixed');
  });

  it('lets unclassifiable paths abstain rather than dilute the winner into "mixed"', () => {
    // Two logic files and two unknowns: without abstention this would be 50% and mixed.
    expect(dominantKind(['src/lib/a.ts', 'src/lib/b.ts', 'x.xyz', 'y.xyz'])).toBe('logic');
  });

  it('returns "mixed" when nothing in a non-empty set could be classified at all', () => {
    expect(dominantKind(['a.xyz', 'b.unknown'])).toBe('mixed');
  });
});

describe('commonDirectory', () => {
  it('returns null for an empty set', () => {
    expect(commonDirectory([])).toBeNull();
  });

  it('returns the deepest directory shared by every path', () => {
    expect(commonDirectory(['src/lib/a.ts', 'src/lib/b.ts'])).toBe('src/lib');
    expect(commonDirectory(['src/lib/deep/a.ts', 'src/lib/b.ts'])).toBe('src/lib');
  });

  it('returns null when the paths diverge at the root', () => {
    expect(commonDirectory(['src/a.ts', 'docs/b.md'])).toBeNull();
  });

  it('returns the containing directory of a single path', () => {
    expect(commonDirectory(['src/lib/auth.ts'])).toBe('src/lib');
  });

  it('returns null for a single root-level file, because "the root" is not a useful scope', () => {
    expect(commonDirectory(['package.json'])).toBeNull();
  });

  it('returns null as soon as one root-level file joins a set that otherwise shares a directory', () => {
    expect(commonDirectory(['src/a.ts', 'src/b.ts', 'package.json'])).toBeNull();
  });

  it('does not treat a partial segment match as shared: src and srcfoo diverge', () => {
    expect(commonDirectory(['src/a.ts', 'srcfoo/b.ts'])).toBeNull();
  });

  it('is order-independent', () => {
    const paths = ['a/b/c/x.ts', 'a/b/y.ts', 'a/b/c/d/z.ts'];
    expect(commonDirectory(paths)).toBe('a/b');
    expect(commonDirectory([...paths].reverse())).toBe('a/b');
  });
});

// ---------------------------------------------------------------------------
// src/core/describe.ts
// ---------------------------------------------------------------------------

describe('summarizeChanges', () => {
  it('describes an empty diff as no changes, no samples, no scope and kind "none"', () => {
    expect(summarizeChanges([])).toEqual({
      counts: { added: 0, modified: 0, deleted: 0 },
      samplePaths: [],
      scope: null,
      kind: 'none',
    });
  });

  it('carries the same counts countChanges would produce', () => {
    const changes = [change('a', 'added'), change('b', 'modified'), change('c', 'deleted')];
    expect(summarizeChanges(changes).counts).toEqual(countChanges(changes));
  });

  it('ranks sample paths modified first, then added, then deleted', () => {
    const changes = [
      change('deleted.ts', 'deleted'),
      change('added.ts', 'added'),
      change('modified.ts', 'modified'),
    ];
    expect(summarizeChanges(changes).samplePaths).toEqual([
      'modified.ts',
      'added.ts',
      'deleted.ts',
    ]);
  });

  it('prefers shallower paths within the same status, since those are the recognisable ones', () => {
    const changes = [
      change('a/b/c/deep.ts', 'modified'),
      change('top.ts', 'modified'),
      change('a/mid.ts', 'modified'),
    ];
    expect(summarizeChanges(changes).samplePaths).toEqual(['top.ts', 'a/mid.ts', 'a/b/c/deep.ts']);
  });

  it('breaks a status-and-depth tie by path so the sample is deterministic', () => {
    const changes = [change('z.ts', 'modified'), change('a.ts', 'modified')];
    expect(summarizeChanges(changes).samplePaths).toEqual(['a.ts', 'z.ts']);
    // Same set, opposite input order, same output.
    expect(summarizeChanges([...changes].reverse()).samplePaths).toEqual(['a.ts', 'z.ts']);
  });

  it('applies status rank before depth: a shallow deletion still loses to a deep edit', () => {
    const changes = [change('gone.ts', 'deleted'), change('a/b/c/edited.ts', 'modified')];
    expect(summarizeChanges(changes).samplePaths).toEqual(['a/b/c/edited.ts', 'gone.ts']);
  });

  it('caps the sample at five paths however many files changed', () => {
    const changes = Array.from({ length: 40 }, (_, index) =>
      change(`src/file-${String(index).padStart(2, '0')}.ts`, 'modified'),
    );
    const summary = summarizeChanges(changes);
    expect(summary.samplePaths).toHaveLength(5);
    expect(summary.counts.modified).toBe(40);
    expect(summary.samplePaths).toEqual([
      'src/file-00.ts',
      'src/file-01.ts',
      'src/file-02.ts',
      'src/file-03.ts',
      'src/file-04.ts',
    ]);
  });

  it('derives scope and kind from the changed paths', () => {
    const summary = summarizeChanges([
      change('src/lib/auth.ts', 'modified'),
      change('src/lib/token.ts', 'added'),
    ]);
    expect(summary.scope).toBe('src/lib');
    expect(summary.kind).toBe('logic');
  });

  it('reports a null scope when the changed paths share no directory', () => {
    const summary = summarizeChanges([
      change('src/a.ts', 'modified'),
      change('docs/b.md', 'modified'),
    ]);
    expect(summary.scope).toBeNull();
    expect(summary.kind).toBe('mixed');
  });

  it("does not mutate or reorder the caller's change list", () => {
    const changes = [change('z.ts', 'deleted'), change('a.ts', 'modified')];
    const copy = structuredClone(changes);
    summarizeChanges(changes);
    expect(changes).toEqual(copy);
  });
});

describe('formatSummary', () => {
  it('renders an English one-liner from a summary', () => {
    const summary = summarizeChanges([
      change('src/lib/auth.ts', 'modified'),
      change('src/lib/token.ts', 'modified'),
    ]);
    expect(formatSummary(summary, 'en')).toBe('Edited 2 files in src/lib · logic');
  });

  it('renders the same summary in Chinese when the language says so', () => {
    const summary = summarizeChanges([
      change('src/lib/auth.ts', 'modified'),
      change('src/lib/token.ts', 'modified'),
    ]);
    expect(formatSummary(summary, 'zh-CN')).toBe('修改 2 个文件，位于 src/lib · 逻辑');
  });

  it('renders the empty summary as the no-changes phrase in both languages', () => {
    const summary = summarizeChanges([]);
    expect(formatSummary(summary, 'en')).toBe('No changes');
    expect(formatSummary(summary, 'zh-CN')).toBe('没有改动');
  });
});

// ---------------------------------------------------------------------------
// src/i18n.ts
// ---------------------------------------------------------------------------

describe('catalog coverage', () => {
  it('exposes a catalogue for every declared language', () => {
    for (const language of LANGUAGES) {
      expect(catalog(language)).toBeDefined();
    }
  });

  it.each(LANGUAGES)('has a non-empty label for every ChangeKind in %s', (language: Language) => {
    const labels = catalog(language).kindLabel;
    // Guards against a variant being added to the union but not to this test.
    expect(Object.keys(labels).sort()).toEqual([...CHANGE_KINDS].sort());
    for (const kind of CHANGE_KINDS) {
      expect(labels[kind].length, `missing ${language} label for kind "${kind}"`).toBeGreaterThan(
        0,
      );
    }
  });

  it.each(LANGUAGES)('has a non-empty label for every HealthStatus in %s', (language: Language) => {
    const labels = catalog(language).healthLabel;
    expect(Object.keys(labels).sort()).toEqual([...HEALTH_STATUSES].sort());
    for (const status of HEALTH_STATUSES) {
      expect(
        labels[status].length,
        `missing ${language} label for health status "${status}"`,
      ).toBeGreaterThan(0);
    }
  });

  it.each(LANGUAGES)(
    'has a non-empty label for every SnapshotTrigger in %s',
    (language: Language) => {
      const labels = catalog(language).triggerLabel;
      expect(Object.keys(labels).sort()).toEqual([...SNAPSHOT_TRIGGERS].sort());
      for (const trigger of SNAPSHOT_TRIGGERS) {
        expect(
          labels[trigger].length,
          `missing ${language} label for trigger "${trigger}"`,
        ).toBeGreaterThan(0);
      }
    },
  );

  it.each(LANGUAGES)('has non-empty noChanges and unknown strings in %s', (language: Language) => {
    expect(catalog(language).noChanges.length).toBeGreaterThan(0);
    expect(catalog(language).unknown.length).toBeGreaterThan(0);
  });

  it('gives the two languages genuinely different wording, not a copied English catalogue', () => {
    expect(catalog('zh-CN').noChanges).not.toBe(catalog('en').noChanges);
    expect(catalog('zh-CN').healthLabel.healthy).not.toBe(catalog('en').healthLabel.healthy);
  });
});

describe('English summary', () => {
  const en = catalog('en');

  it('attaches the noun to the first clause only: "Edited 1 file, added 1"', () => {
    expect(en.summary({ counts: counts(1, 1, 0), scope: null, kind: 'none' })).toBe(
      'Edited 1 file, added 1',
    );
  });

  it('never says "added 1 files" — the count belongs to the verb it follows', () => {
    const text = en.summary({ counts: counts(1, 1, 0), scope: null, kind: 'none' });
    expect(text).not.toContain('added 1 files');
    expect(text).not.toContain('Edited 1, ');
  });

  it('uses the noun exactly once in every non-empty combination of counts', () => {
    for (let modified = 0; modified <= 2; modified += 1) {
      for (let added = 0; added <= 2; added += 1) {
        for (let deleted = 0; deleted <= 2; deleted += 1) {
          if (modified + added + deleted === 0) continue;
          const text = en.summary({
            counts: counts(modified, added, deleted),
            scope: null,
            kind: 'none',
          });
          const nouns = text.match(/\bfiles?\b/g) ?? [];
          expect(nouns, `for ${modified}/${added}/${deleted}: ${text}`).toHaveLength(1);
          // …and it agrees with the leading clause's count, not with the total.
          const leading = [modified, added, deleted].find((count) => count > 0)!;
          expect(nouns[0], `for ${modified}/${added}/${deleted}: ${text}`).toBe(
            leading === 1 ? 'file' : 'files',
          );
        }
      }
    }
  });

  it('uses the singular noun for one file and the plural for more', () => {
    expect(en.summary({ counts: counts(1, 0, 0), scope: null, kind: 'none' })).toBe(
      'Edited 1 file',
    );
    expect(en.summary({ counts: counts(2, 0, 0), scope: null, kind: 'none' })).toBe(
      'Edited 2 files',
    );
  });

  it('agrees the noun with the FIRST clause, not with the total', () => {
    // One edit plus three additions: the leading clause is singular even though four
    // files changed overall.
    expect(en.summary({ counts: counts(1, 3, 0), scope: null, kind: 'none' })).toBe(
      'Edited 1 file, added 3',
    );
    expect(en.summary({ counts: counts(3, 1, 0), scope: null, kind: 'none' })).toBe(
      'Edited 3 files, added 1',
    );
  });

  it('orders the clauses edited, added, deleted', () => {
    expect(en.summary({ counts: counts(2, 1, 3), scope: null, kind: 'none' })).toBe(
      'Edited 2 files, added 1, deleted 3',
    );
  });

  it('omits a clause whose count is zero', () => {
    expect(en.summary({ counts: counts(0, 0, 3), scope: null, kind: 'none' })).toBe(
      'Deleted 3 files',
    );
    expect(en.summary({ counts: counts(0, 5, 0), scope: null, kind: 'none' })).toBe(
      'Added 5 files',
    );
  });

  it('falls back to the no-changes phrase when every count is zero', () => {
    expect(en.summary({ counts: counts(0, 0, 0), scope: null, kind: 'logic' })).toBe('No changes');
  });

  it('appends the scope when one exists and omits it when it does not', () => {
    expect(en.summary({ counts: counts(1, 0, 0), scope: 'src/lib', kind: 'none' })).toBe(
      'Edited 1 file in src/lib',
    );
    expect(en.summary({ counts: counts(1, 0, 0), scope: null, kind: 'none' })).toBe(
      'Edited 1 file',
    );
  });

  it('appends a kind label for a real kind and stays silent for none and mixed', () => {
    expect(en.summary({ counts: counts(1, 0, 0), scope: null, kind: 'style' })).toBe(
      'Edited 1 file · styling',
    );
    expect(en.summary({ counts: counts(1, 0, 0), scope: null, kind: 'mixed' })).toBe(
      'Edited 1 file',
    );
    expect(en.summary({ counts: counts(1, 0, 0), scope: null, kind: 'none' })).toBe(
      'Edited 1 file',
    );
  });

  it('combines counts, scope and kind in that order', () => {
    expect(en.summary({ counts: counts(2, 1, 0), scope: 'src', kind: 'ui' })).toBe(
      'Edited 2 files, added 1 in src · UI',
    );
  });
});

describe('Chinese summary', () => {
  const zh = catalog('zh-CN');

  it('joins clauses with the enumeration comma and puts 文件 at the end', () => {
    expect(zh.summary({ counts: counts(1, 1, 0), scope: null, kind: 'none' })).toBe(
      '修改 1 个、新增 1 个文件',
    );
  });

  it('does not inflect for number, so one and many read identically apart from the digit', () => {
    expect(zh.summary({ counts: counts(1, 0, 0), scope: null, kind: 'none' })).toBe(
      '修改 1 个文件',
    );
    expect(zh.summary({ counts: counts(9, 0, 0), scope: null, kind: 'none' })).toBe(
      '修改 9 个文件',
    );
  });

  it('orders the clauses 修改, 新增, 删除', () => {
    expect(zh.summary({ counts: counts(2, 1, 3), scope: null, kind: 'none' })).toBe(
      '修改 2 个、新增 1 个、删除 3 个文件',
    );
  });

  it('appends scope and kind, and omits the kind for none and mixed', () => {
    expect(zh.summary({ counts: counts(0, 0, 2), scope: 'src/ui', kind: 'ui' })).toBe(
      '删除 2 个文件，位于 src/ui · 界面',
    );
    expect(zh.summary({ counts: counts(0, 0, 2), scope: 'src/ui', kind: 'mixed' })).toBe(
      '删除 2 个文件，位于 src/ui',
    );
  });

  it('falls back to the no-changes phrase when every count is zero', () => {
    expect(zh.summary({ counts: counts(0, 0, 0), scope: 'src', kind: 'logic' })).toBe('没有改动');
  });
});

describe('relativeTime', () => {
  const en = catalog('en');
  const zh = catalog('zh-CN');

  it('says "just now" below the 45-second boundary and switches to minutes at it', () => {
    expect(en.relativeTime(0)).toBe('just now');
    expect(en.relativeTime(44 * SECOND)).toBe('just now');
    expect(en.relativeTime(45 * SECOND)).toBe('1 min ago');
    expect(zh.relativeTime(0)).toBe('刚刚');
    expect(zh.relativeTime(44 * SECOND)).toBe('刚刚');
    expect(zh.relativeTime(45 * SECOND)).toBe('1 分钟前');
  });

  it('reports minutes up to the hour boundary', () => {
    expect(en.relativeTime(5 * MINUTE)).toBe('5 min ago');
    expect(en.relativeTime(59 * MINUTE)).toBe('59 min ago');
    expect(zh.relativeTime(5 * MINUTE)).toBe('5 分钟前');
    expect(zh.relativeTime(59 * MINUTE)).toBe('59 分钟前');
  });

  it('switches to hours at 60 minutes and pluralises the English noun', () => {
    expect(en.relativeTime(HOUR)).toBe('1 hour ago');
    expect(en.relativeTime(2 * HOUR)).toBe('2 hours ago');
    expect(en.relativeTime(23 * HOUR)).toBe('23 hours ago');
    expect(zh.relativeTime(HOUR)).toBe('1 小时前');
    expect(zh.relativeTime(23 * HOUR)).toBe('23 小时前');
  });

  it('says "yesterday" for exactly one day rather than "1 days ago"', () => {
    expect(en.relativeTime(DAY)).toBe('yesterday');
    expect(zh.relativeTime(DAY)).toBe('昨天');
  });

  it('reports days from two up to the month boundary', () => {
    expect(en.relativeTime(2 * DAY)).toBe('2 days ago');
    expect(en.relativeTime(29 * DAY)).toBe('29 days ago');
    expect(zh.relativeTime(3 * DAY)).toBe('3 天前');
    expect(zh.relativeTime(29 * DAY)).toBe('29 天前');
  });

  it('switches to months at 30 days', () => {
    expect(en.relativeTime(30 * DAY)).toBe('1 month ago');
    expect(en.relativeTime(60 * DAY)).toBe('2 months ago');
    expect(zh.relativeTime(30 * DAY)).toBe('1 个月前');
    expect(zh.relativeTime(60 * DAY)).toBe('2 个月前');
  });

  it('switches to years at twelve months', () => {
    expect(en.relativeTime(360 * DAY)).toBe('1y ago');
    expect(en.relativeTime(730 * DAY)).toBe('2y ago');
    expect(zh.relativeTime(360 * DAY)).toBe('1 年前');
    expect(zh.relativeTime(730 * DAY)).toBe('2 年前');
  });

  it('clamps a negative delta to "just now" so clock skew never renders a future time', () => {
    for (const language of LANGUAGES) {
      const text = catalog(language).relativeTime(-5 * MINUTE);
      expect(text).toBe(catalog(language).relativeTime(0));
      expect(text).not.toContain('-');
    }
  });

  it('never emits a negative or NaN number for any plausible delta', () => {
    const deltas = [0, 1, SECOND, MINUTE, HOUR, DAY, 400 * DAY, 4_000 * DAY];
    for (const language of LANGUAGES) {
      for (const delta of deltas) {
        const text = catalog(language).relativeTime(delta);
        expect(text).not.toMatch(/-\d|NaN|Infinity/);
        expect(text.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// src/cli/ui.ts
// ---------------------------------------------------------------------------

describe('displayWidth', () => {
  it('counts an ASCII character as one column', () => {
    expect(displayWidth('a')).toBe(1);
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('')).toBe(0);
  });

  it('counts a CJK ideograph as two columns, which String.length gets wrong', () => {
    expect(displayWidth('中')).toBe(2);
    expect('中'.length).toBe(1);
    expect(displayWidth('中文')).toBe(4);
  });

  it('counts Hangul and fullwidth punctuation as two columns', () => {
    expect(displayWidth('한')).toBe(2);
    expect(displayWidth('，')).toBe(2);
  });

  it('counts a combining mark as zero columns, so "e" plus an accent is still one', () => {
    const combiningAcute = String.fromCharCode(0x0301);
    expect(displayWidth(combiningAcute)).toBe(0);
    expect(displayWidth(`e${combiningAcute}`)).toBe(1);
  });

  it('counts a zero-width space and a variation selector as zero columns', () => {
    expect(displayWidth(String.fromCharCode(0x200b))).toBe(0);
    expect(displayWidth(String.fromCharCode(0xfe0f))).toBe(0);
  });

  it('counts an astral emoji as two columns rather than two surrogate halves', () => {
    expect(displayWidth('\u{1F600}')).toBe(2);
    expect('\u{1F600}'.length).toBe(2);
  });

  it('ignores ANSI colour sequences, so a coloured cell measures like a plain one', () => {
    const coloured = `${ESC}[31mabc${ESC}[39m`;
    expect(displayWidth(coloured)).toBe(3);
    expect(displayWidth(coloured)).toBe(displayWidth('abc'));
  });

  it('ignores ANSI sequences wrapping wide text too', () => {
    expect(displayWidth(`${ESC}[1m中文${ESC}[22m`)).toBe(4);
  });

  it('is additive over concatenation for the strings this tool renders', () => {
    const parts = ['abc', '中文', '\u{1F600}', ''];
    const total = parts.reduce((sum, part) => sum + displayWidth(part), 0);
    expect(displayWidth(parts.join(''))).toBe(total);
  });
});

describe('stripAnsi', () => {
  it('removes SGR sequences and leaves the visible text untouched', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[39m`)).toBe('red');
    expect(stripAnsi('plain')).toBe('plain');
  });

  it('is idempotent', () => {
    const once = stripAnsi(`${ESC}[1m中${ESC}[22m`);
    expect(stripAnsi(once)).toBe(once);
  });
});

describe('padEnd', () => {
  it('pads a short string to the requested display width', () => {
    expect(padEnd('ab', 5)).toBe('ab   ');
    expect(displayWidth(padEnd('ab', 5))).toBe(5);
  });

  it('pads by display width, not by String.length, so CJK lands in the right column', () => {
    expect(displayWidth(padEnd('中文', 8))).toBe(8);
    expect(padEnd('中文', 8)).toBe('中文    ');
  });

  it('returns over-long input unchanged rather than truncating it', () => {
    expect(padEnd('hello', 3)).toBe('hello');
    expect(padEnd('中文', 1)).toBe('中文');
  });

  it('returns exact-width input unchanged with no trailing space', () => {
    expect(padEnd('abc', 3)).toBe('abc');
    expect(padEnd('中', 2)).toBe('中');
  });

  it('treats a zero or negative width as "no padding"', () => {
    expect(padEnd('ab', 0)).toBe('ab');
    expect(padEnd('ab', -4)).toBe('ab');
  });
});

describe('truncate', () => {
  it('returns the string unchanged when it already fits', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
    expect(truncate('中文', 4)).toBe('中文');
  });

  it('replaces the overflow with a single-column ellipsis', () => {
    expect(truncate('hello world', 5)).toBe('hell…');
  });

  it('stops before a wide character it cannot fit, never splitting one in half', () => {
    expect(truncate('中文测试', 5)).toBe('中文…');
    expect(truncate('中文测试', 4)).toBe('中…');
  });

  it('never returns a lone surrogate when cutting through an astral character', () => {
    const result = truncate('a\u{1F600}bc', 3);
    for (const character of result) {
      const code = character.codePointAt(0)!;
      expect(code < 0xd800 || code > 0xdfff, `lone surrogate in ${JSON.stringify(result)}`).toBe(
        true,
      );
    }
  });

  it('never exceeds the requested width for any string at any width from 1 upward', () => {
    const samples = [
      'hello world',
      '中文测试内容',
      'mixed 中文 and ascii',
      'a\u{1F600}b\u{1F600}c',
      `${ESC}[31mcoloured text${ESC}[39m`,
      'éaccented',
      '',
      'x',
    ];
    for (const sample of samples) {
      for (let width = 1; width <= 14; width += 1) {
        const result = truncate(sample, width);
        expect(
          displayWidth(result),
          `truncate(${JSON.stringify(sample)}, ${width}) = ${JSON.stringify(result)}`,
        ).toBeLessThanOrEqual(width);
      }
    }
  });

  it('collapses to the bare ellipsis when only one column is available', () => {
    expect(truncate('hello', 1)).toBe('…');
    expect(truncate('中', 1)).toBe('…');
  });

  it('leaves an empty string alone at any width', () => {
    expect(truncate('', 0)).toBe('');
    expect(truncate('', 5)).toBe('');
  });

  // BUG: truncate(text, 0) returns '…', which is one column wide, so the result
  // exceeds the requested budget of zero columns. Expected '' — a zero-column budget
  // has no room even for the ellipsis. Same for negative widths. Not reachable from
  // today's callers (renderTable only produces width 0 when every cell is empty, and
  // truncate('', 0) correctly returns ''), so this is latent rather than live, but it
  // is the one input that breaks the "never exceeds the requested width" invariant.
  it('returns nothing at all when zero columns are available', () => {
    expect(truncate('hello', 0)).toBe('');
    expect(displayWidth(truncate('hello', 0))).toBeLessThanOrEqual(0);
  });
});

describe('renderTable', () => {
  it('renders just the header row when there are no data rows', () => {
    const lines = renderTable([{ header: 'ID' }, { header: 'WHEN' }], []).split('\n');
    expect(lines).toHaveLength(1);
    expect(stripAnsi(lines[0]!)).toBe('ID  WHEN');
  });

  it('sizes each column to the widest of its header and its cells', () => {
    const rendered = renderTable([{ header: 'ID' }, { header: 'WHAT' }], [['abcdef', 'x']]);
    const lines = rendered.split('\n').map(stripAnsi);
    expect(lines[0]).toBe('ID      WHAT');
    expect(lines[1]).toBe('abcdef  x');
  });

  it('aligns every column at the same terminal offset when cells contain Chinese', () => {
    const columns: Column[] = [{ header: 'ID' }, { header: 'WHAT' }, { header: 'SIZE' }];
    const rows = [
      ['a1', '修改 2 个文件', 'aaa'],
      ['bb22', 'No changes', 'bbb'],
      ['c', '界面样式', 'ccc'],
    ];
    const lines = renderTable(columns, rows).split('\n').map(stripAnsi);

    // Column 0 is four columns wide ("bb22"), so column 1 must start at offset 6 on
    // every line including the header.
    const secondCells = ['WHAT', ...rows.map((row) => row[1]!)];
    for (const [index, line] of lines.entries()) {
      const needle = secondCells[index]!;
      const at = line.indexOf(needle);
      expect(at, `"${needle}" not found in ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
      expect(displayWidth(line.slice(0, at)), `line ${index}: ${JSON.stringify(line)}`).toBe(6);
    }

    // Column 2 starts after the widest column-1 cell ("修改 2 个文件" = 13 columns).
    const thirdCells = ['SIZE', ...rows.map((row) => row[2]!)];
    for (const [index, line] of lines.entries()) {
      const needle = thirdCells[index]!;
      const at = line.indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(displayWidth(line.slice(0, at)), `line ${index}: ${JSON.stringify(line)}`).toBe(
        6 + 13 + 2,
      );
    }
  });

  it('gives every data row an identical display width when the last column is right-aligned', () => {
    const columns: Column[] = [
      { header: 'ID' },
      { header: '描述' },
      { header: 'SIZE', align: 'right' },
    ];
    const rows = [
      ['a1', '修改 2 个文件', '1.0 KiB'],
      ['bb22', 'No changes', '12 B'],
      ['c', '界面', '999 B'],
    ];
    const lines = renderTable(columns, rows).split('\n').map(stripAnsi).slice(1);
    const widths = new Set(lines.map((line) => displayWidth(line)));
    expect(widths.size, `row widths: ${[...widths].join(', ')}`).toBe(1);
  });

  it('right-aligns a column by padding on the left, so digits line up on their last place', () => {
    const rendered = renderTable([{ header: 'SIZE', align: 'right' }], [['1'], ['1000']]);
    const lines = rendered.split('\n').map(stripAnsi);
    expect(lines[1]).toBe('   1');
    expect(lines[2]).toBe('1000');
  });

  it('trims trailing whitespace so no line carries invisible padding', () => {
    const rendered = renderTable(
      [{ header: 'A' }, { header: 'B' }],
      [
        ['xx', 'y'],
        ['x', 'yy'],
      ],
    );
    for (const line of rendered.split('\n')) {
      expect(line).toBe(line.trimEnd());
    }
  });

  it('substitutes an empty cell for a row shorter than the column list', () => {
    const rendered = renderTable([{ header: 'A' }, { header: 'B' }], [['only']]);
    const lines = rendered.split('\n').map(stripAnsi);
    expect(lines[1]).toBe('only');
  });

  it('truncates a cell that exceeds the column maxWidth and keeps the next column aligned', () => {
    const columns: Column[] = [{ header: 'WHAT', maxWidth: 6 }, { header: 'TAG' }];
    const rows = [
      ['a very long description indeed', 'one'],
      ['短', 'two'],
    ];
    const lines = renderTable(columns, rows).split('\n').map(stripAnsi).slice(1);
    for (const [index, line] of lines.entries()) {
      const needle = rows[index]![1]!;
      const at = line.indexOf(needle);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(displayWidth(line.slice(0, at))).toBe(8);
    }
    expect(lines[0]).toContain('…');
  });

  it('truncates a wide-character cell to the column budget without overflowing it', () => {
    const rendered = renderTable([{ header: 'W', maxWidth: 5 }], [['中文测试内容']]);
    const cell = stripAnsi(rendered.split('\n')[1]!);
    expect(displayWidth(cell)).toBeLessThanOrEqual(5);
  });

  it('renders an empty column list as a single empty line', () => {
    expect(stripAnsi(renderTable([], []))).toBe('');
  });

  // BUG: a column whose `maxWidth` is narrower than its own header keeps the full
  // header — renderTable pads the header with padEnd but never truncates it — so the
  // header line runs wider than every data row and the table stops lining up.
  // Expected: the header is bounded by maxWidth exactly as the cells are. Latent
  // today (src/cli/commands.ts only uses maxWidth 52 and 20, both far wider than the
  // "WHAT" and "TAG" headers), but it is a real alignment break for any narrower
  // column added later.
  it('bounds the header by maxWidth too, so a narrow column still lines up', () => {
    const rendered = renderTable([{ header: 'DESCRIPTION', maxWidth: 4 }], [['abcdefgh']]);
    const lines = rendered.split('\n').map(stripAnsi);
    expect(displayWidth(lines[0]!)).toBeLessThanOrEqual(4);
    expect(displayWidth(lines[0]!)).toBe(displayWidth(lines[1]!));
  });
});

// ---------------------------------------------------------------------------
// src/util/fsx.ts — formatBytes / stripBom / toRepoPath
// ---------------------------------------------------------------------------

describe('formatBytes', () => {
  it('reports raw bytes below one kibibyte', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('switches to binary units at exactly 1024, not at 1000', () => {
    expect(formatBytes(1024)).toBe('1.0 KiB');
    expect(formatBytes(1000)).toBe('1000 B');
  });

  it('keeps one decimal place below ten and drops it above, to keep columns narrow', () => {
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(10 * 1024)).toBe('10 KiB');
    expect(formatBytes(999 * 1024)).toBe('999 KiB');
  });

  it('climbs through KiB, MiB, GiB and TiB', () => {
    expect(formatBytes(1024 ** 2)).toBe('1.0 MiB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GiB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TiB');
  });

  it('stops at TiB rather than inventing a larger unit', () => {
    expect(formatBytes(1024 ** 5)).toBe('1024 TiB');
  });

  it('returns "?" rather than throwing or printing nonsense for impossible sizes', () => {
    expect(formatBytes(-1)).toBe('?');
    expect(formatBytes(Number.NaN)).toBe('?');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('?');
    expect(formatBytes(Number.NEGATIVE_INFINITY)).toBe('?');
  });

  it('never renders a NaN or undefined unit', () => {
    for (const bytes of [0, 1, 1023, 1024, 1024 ** 2, 1024 ** 3, 1024 ** 4, 1024 ** 6]) {
      expect(formatBytes(bytes)).not.toMatch(/NaN|undefined/);
    }
  });
});

describe('stripBom', () => {
  it('removes a UTF-8 BOM at position zero so JSON.parse accepts the rest', () => {
    expect(stripBom(`${BOM}{"a":1}`)).toBe('{"a":1}');
    expect(() => JSON.parse(stripBom(`${BOM}{"a":1}`)) as unknown).not.toThrow();
    // …and without the strip it would not: this is why readJsonFile calls it.
    expect(() => JSON.parse(`${BOM}{"a":1}`) as unknown).toThrow();
  });

  it('leaves text without a BOM untouched', () => {
    expect(stripBom('{"a":1}')).toBe('{"a":1}');
    expect(stripBom('')).toBe('');
  });

  it('strips only one BOM, leaving a second occurrence visible rather than silently eating it', () => {
    expect(stripBom(`${BOM}${BOM}x`)).toBe(`${BOM}x`);
  });

  it('never touches a BOM that is not at the very start', () => {
    expect(stripBom(`a${BOM}b`)).toBe(`a${BOM}b`);
  });

  it('is idempotent after the first application', () => {
    const once = stripBom(`${BOM}text`);
    expect(stripBom(once)).toBe(once);
  });
});

describe('toRepoPath', () => {
  it('converts host separators to forward slashes so stores are cross-platform', () => {
    expect(toRepoPath(['src', 'core', 'cas.ts'].join(path.sep))).toBe('src/core/cas.ts');
  });

  it('leaves an already-POSIX path unchanged', () => {
    expect(toRepoPath('src/core/cas.ts')).toBe('src/core/cas.ts');
  });

  it('leaves a bare filename unchanged', () => {
    expect(toRepoPath('package.json')).toBe('package.json');
    expect(toRepoPath('')).toBe('');
  });

  it('round-trips through fromRepoPath for any repo-relative path', () => {
    for (const repoPath of ['a', 'a/b', 'a/b/c.ts', 'deep/nested/dir/file.name.ext']) {
      expect(toRepoPath(fromRepoPath(repoPath))).toBe(repoPath);
    }
  });

  // Backslash-to-slash conversion is only observable where path.sep is a backslash.
  describe.skipIf(process.platform !== 'win32')('on Windows', () => {
    it('rewrites backslashes, so no snapshot record ever stores a Windows separator', () => {
      expect(toRepoPath('src\\core\\cas.ts')).toBe('src/core/cas.ts');
    });

    it('normalises a mixed-separator path to all forward slashes', () => {
      expect(toRepoPath('src\\core/cas.ts')).toBe('src/core/cas.ts');
    });
  });

  // On POSIX a backslash is a legal filename character and must survive untouched.
  describe.skipIf(process.platform === 'win32')('on POSIX', () => {
    it('preserves a backslash, which is a valid character in a POSIX filename', () => {
      expect(toRepoPath('weird\\name.ts')).toBe('weird\\name.ts');
    });
  });
});

// ---------------------------------------------------------------------------
// src/config.ts — parseConfig / isLoopbackHost
// ---------------------------------------------------------------------------

/** Run `parseConfig` and return the issues it reported, failing if it accepted. */
function issuesFor(input: unknown): readonly string[] {
  try {
    parseConfig(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ValidationError);
    return (error as ValidationError).issues;
  }
  throw new Error(`parseConfig accepted invalid input: ${JSON.stringify(input)}`);
}

describe('parseConfig defaults', () => {
  it('fills every field from the defaults when given an empty object', () => {
    expect(parseConfig({})).toEqual(defaultConfig());
  });

  it('treats null and undefined as "no config file" rather than an error', () => {
    expect(parseConfig(null)).toEqual(defaultConfig());
    expect(parseConfig(undefined)).toEqual(defaultConfig());
  });

  it('is idempotent: re-parsing its own output yields the same config', () => {
    const once = parseConfig({});
    expect(parseConfig(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });

  it('accepts a config it produced itself after a JSON round-trip', () => {
    const config = defaultConfig('zh-CN');
    const roundTripped = parseConfig(JSON.parse(JSON.stringify(config)));
    expect(roundTripped).toEqual(config);
  });

  it('merges a partial section over the defaults without dropping its siblings', () => {
    const config = parseConfig({ watch: { quietPeriodMs: 500 } });
    expect(config.watch.quietPeriodMs).toBe(500);
    expect(config.watch.maxWaitMs).toBe(defaultConfig().watch.maxWaitMs);
    expect(config.retention).toEqual(defaultConfig().retention);
  });

  it('always reports version 1 regardless of what the file claims', () => {
    expect(parseConfig({}).version).toBe(1);
  });

  it('defaults to a loopback bind so a fresh install never listens publicly', () => {
    expect(isLoopbackHost(parseConfig({}).server.host)).toBe(true);
  });
});

describe('parseConfig rejections', () => {
  it('refuses a non-loopback server.host, because the UI exposes the source tree', () => {
    for (const host of ['0.0.0.0', '192.168.1.5', '::', 'example.com', '10.0.0.7']) {
      const issues = issuesFor({ server: { host } });
      expect(issues.some((issue) => issue.startsWith('config.server.host:'))).toBe(true);
      expect(issues.join(' ')).toContain('loopback');
    }
  });

  it('accepts every loopback spelling of the host', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.0.0.2']) {
      expect(parseConfig({ server: { host } }).server.host).toBe(host);
    }
  });

  it('refuses health.enabled with no command, since there would be nothing to run', () => {
    const issues = issuesFor({ health: { enabled: true } });
    expect(issues.some((issue) => issue.startsWith('config.health.command:'))).toBe(true);
  });

  it('refuses health.enabled with an explicit null command', () => {
    const issues = issuesFor({ health: { enabled: true, command: null } });
    expect(issues.some((issue) => issue.startsWith('config.health.command:'))).toBe(true);
  });

  it('accepts health.enabled when a command is supplied', () => {
    const config = parseConfig({ health: { enabled: true, command: 'npm test' } });
    expect(config.health.enabled).toBe(true);
    expect(config.health.command).toBe('npm test');
  });

  it('refuses maxWaitMs below quietPeriodMs, which would make debouncing incoherent', () => {
    const issues = issuesFor({ watch: { quietPeriodMs: 9_000, maxWaitMs: 5_000 } });
    const issue = issues.find((text) => text.startsWith('config.watch.maxWaitMs:'));
    expect(issue).toBeDefined();
    expect(issue).toContain('9000');
  });

  it('accepts maxWaitMs exactly equal to quietPeriodMs', () => {
    const config = parseConfig({ watch: { quietPeriodMs: 5_000, maxWaitMs: 5_000 } });
    expect(config.watch.maxWaitMs).toBe(5_000);
  });

  it('refuses an empty successExitCodes list, which would make every run "broken"', () => {
    const issues = issuesFor({ health: { successExitCodes: [] } });
    expect(issues.some((issue) => issue.startsWith('config.health.successExitCodes:'))).toBe(true);
  });

  it('accepts a multi-value successExitCodes list', () => {
    expect(parseConfig({ health: { successExitCodes: [0, 1] } }).health.successExitCodes).toEqual([
      0, 1,
    ]);
  });

  it('flags an unknown key at the root and names the options it does know', () => {
    const issues = issuesFor({ langauge: 'en' });
    const issue = issues.find((text) => text.startsWith('config.langauge:'));
    expect(issue).toBeDefined();
    expect(issue).toContain('unknown option');
    expect(issue).toContain('language');
  });

  it('flags an unknown key inside a nested section', () => {
    const issues = issuesFor({ watch: { quietPeriod: 100 } });
    expect(issues.some((text) => text.startsWith('config.watch.quietPeriod:'))).toBe(true);
  });

  it.each([
    ['config.maxFileBytes', { maxFileBytes: 10 }],
    ['config.maxFileBytes', { maxFileBytes: 5 * 1024 * 1024 * 1024 }],
    ['config.watch.quietPeriodMs', { watch: { quietPeriodMs: 1 } }],
    ['config.watch.reconcileIntervalMs', { watch: { reconcileIntervalMs: -1 } }],
    ['config.health.timeoutMs', { health: { timeoutMs: 10 } }],
    ['config.retention.maxSnapshots', { retention: { maxSnapshots: 0 } }],
    ['config.server.port', { server: { port: 70_000 } }],
    ['config.server.port', { server: { port: -1 } }],
  ])('flags %s when the number is out of range', (field: string, input: unknown) => {
    const issues = issuesFor(input);
    expect(issues.some((issue) => issue.startsWith(`${field}:`))).toBe(true);
  });

  it('refuses a fractional value where a whole number is required', () => {
    const issues = issuesFor({ maxFileBytes: 2048.5 });
    const issue = issues.find((text) => text.startsWith('config.maxFileBytes:'));
    expect(issue).toContain('whole number');
  });

  it('refuses a value of the wrong type and says what it wanted', () => {
    expect(issuesFor({ useGitignore: 'yes' })[0]).toContain('true or false');
    expect(issuesFor({ ignore: 'node_modules/' })[0]).toContain('an array of strings');
    expect(issuesFor({ language: 'fr' })[0]).toContain('one of');
  });

  it('refuses a non-object config, and a top-level array in particular', () => {
    expect(issuesFor('not a config')[0]).toContain('config: expected an object');
    expect(issuesFor([])[0]).toContain('config: expected an object');
    expect(issuesFor(42)[0]).toContain('config: expected an object');
  });

  it('refuses a section that is not an object', () => {
    expect(issuesFor({ watch: 'fast' })[0]).toContain('config.watch: expected an object');
  });

  it('reports every problem in one ValidationError instead of stopping at the first', () => {
    const issues = issuesFor({
      server: { host: '0.0.0.0' },
      health: { enabled: true, successExitCodes: [] },
      watch: { quietPeriodMs: 9_000, maxWaitMs: 5_000 },
    });
    const fields = [
      'config.server.host',
      'config.health.command',
      'config.health.successExitCodes',
      'config.watch.maxWaitMs',
    ];
    for (const field of fields) {
      expect(
        issues.some((issue) => issue.startsWith(`${field}:`)),
        `missing issue for ${field} in: ${issues.join(' | ')}`,
      ).toBe(true);
    }
    expect(issues.length).toBeGreaterThanOrEqual(fields.length);
  });

  it('collects per-element issues from arrays alongside everything else', () => {
    const issues = issuesFor({
      ignore: ['ok', 7, {}],
      health: { successExitCodes: [0, 'one'] },
      nope: true,
    });
    expect(issues.some((issue) => issue.startsWith('config.ignore[1]:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('config.ignore[2]:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('config.health.successExitCodes[1]:'))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.startsWith('config.nope:'))).toBe(true);
  });

  it('throws a ValidationError whose message contains every issue, for the CLI hint', () => {
    let caught: unknown;
    try {
      parseConfig({ server: { host: '0.0.0.0' }, retention: { maxSnapshots: 0 } });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const error = caught as ValidationError;
    for (const issue of error.issues) {
      expect(error.message).toContain(issue);
    }
  });
});

describe('isLoopbackHost', () => {
  it('accepts the canonical loopback spellings', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
  });

  it('accepts the whole 127.0.0.0/8 range, not just 127.0.0.1', () => {
    expect(isLoopbackHost('127.5.5.5')).toBe(true);
    expect(isLoopbackHost('127.0.0.2')).toBe(true);
  });

  it('accepts the bracketed IPv6 form used in a URL authority', () => {
    expect(isLoopbackHost('[::1]')).toBe(true);
  });

  it('is case-insensitive and tolerant of surrounding whitespace', () => {
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('  localhost  ')).toBe(true);
  });

  it('rejects the wildcard bind, which is exactly the public exposure this guards', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });

  it('rejects private LAN addresses, which are still reachable by other machines', () => {
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('10.0.0.1')).toBe(false);
    expect(isLoopbackHost('172.16.0.1')).toBe(false);
  });

  it('rejects public addresses and ordinary hostnames', () => {
    expect(isLoopbackHost('8.8.8.8')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('')).toBe(false);
  });

  it('rejects a hostname that merely contains "localhost" as a substring', () => {
    expect(isLoopbackHost('notlocalhost')).toBe(false);
    expect(isLoopbackHost('localhost.evil.example.com')).toBe(false);
  });

  // Regression test for a DNS-rebinding bypass: `isLoopbackHost` used to test the raw
  // string against `/^127\./`, which accepts `127.attacker.example.com` — a perfectly
  // registerable domain. Since http.ts uses this to validate the incoming `Host`
  // header, that let an attacker's page reach the local server with same-origin
  // standing. Only a genuine dotted quad in 127.0.0.0/8 may pass.
  it('rejects a hostname that merely starts with "127." but is not an IP address', () => {
    expect(isLoopbackHost('127.attacker.example.com')).toBe(false);
    expect(isLoopbackHost('127.0.0.1.attacker.example.com')).toBe(false);
    expect(isLoopbackHost('127.example.com')).toBe(false);
  });

  it('accepts every genuine address in 127.0.0.0/8', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('127.1.2.3')).toBe(true);
    expect(isLoopbackHost('127.255.255.254')).toBe(true);
  });

  it('rejects a dotted quad with an out-of-range or leading-zero octet', () => {
    // Leading zeros are refused rather than interpreted, because some resolvers read
    // them as octal and a security control should not have two possible readings.
    expect(isLoopbackHost('127.0.0.256')).toBe(false);
    expect(isLoopbackHost('127.00.0.1')).toBe(false);
    expect(isLoopbackHost('127.0.0.01')).toBe(false);
  });

  it('rejects alternative encodings of 127.0.0.1 rather than guessing at them', () => {
    // Erring towards refusal is the safe direction for a security control.
    expect(isLoopbackHost('2130706433')).toBe(false);
    expect(isLoopbackHost('0x7f000001')).toBe(false);
  });
});
