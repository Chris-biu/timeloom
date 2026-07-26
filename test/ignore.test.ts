import { describe, expect, it } from 'vitest';

import { DEFAULT_IGNORE } from '../src/config.js';
import { compileRule, IgnoreMatcher, parseIgnoreFile } from '../src/core/ignore.js';

/**
 * `src/core/ignore.ts` is pure — it never touches the filesystem — so these tests
 * build matchers in memory and assert on repo-relative POSIX paths. That also means
 * they are trivially parallel-safe and need no temp directories.
 */

/** A matcher with `patterns` rooted at the project root. */
function rooted(patterns: string[]): IgnoreMatcher {
  return new IgnoreMatcher().addPatterns('', patterns, 'test');
}

/** Shorthand: does `patterns` ignore `path` (full decision, ancestors included)? */
function ignores(patterns: string[], path: string, isDirectory = false): boolean {
  return rooted(patterns).isIgnored(path, isDirectory);
}

const BOM = String.fromCharCode(0xfeff);

// ---------------------------------------------------------------------------
// Line parsing
// ---------------------------------------------------------------------------

describe('parseIgnoreFile', () => {
  it('splits on LF and on CRLF so a Windows-authored ignore file parses identically', () => {
    expect(parseIgnoreFile('a\nb\n')).toEqual(['a', 'b', '']);
    expect(parseIgnoreFile('a\r\nb\r\n')).toEqual(['a', 'b', '']);
  });

  it('strips a leading UTF-8 BOM so the first pattern in the file still matches', () => {
    expect(parseIgnoreFile(`${BOM}node_modules/\n*.log`)).toEqual(['node_modules/', '*.log']);
  });

  it('only strips the BOM at position zero, never a later occurrence', () => {
    expect(parseIgnoreFile(`a\n${BOM}b`)).toEqual(['a', `${BOM}b`]);
  });

  it('returns comment and blank lines verbatim, leaving interpretation to the compiler', () => {
    expect(parseIgnoreFile('# c\n\n  \nx')).toEqual(['# c', '', '  ', 'x']);
  });
});

describe('pattern line syntax', () => {
  it('treats a line starting with # as a comment and compiles no rule', () => {
    expect(compileRule('# not a pattern', '', 'test:1')).toBeNull();
  });

  it('treats blank and whitespace-only lines as no rule at all', () => {
    expect(compileRule('', '', 'test:1')).toBeNull();
    expect(compileRule('   ', '', 'test:1')).toBeNull();
    expect(compileRule('\t \t', '', 'test:1')).toBeNull();
  });

  it('treats # as a literal when it is not the first character of the line', () => {
    expect(ignores(['foo#bar'], 'foo#bar')).toBe(true);
    expect(ignores(['foo#bar'], 'foo')).toBe(false);
  });

  it('strips unescaped trailing whitespace from a pattern', () => {
    expect(ignores(['spaced   '], 'spaced')).toBe(true);
    expect(ignores(['spaced   '], 'spaced   ')).toBe(false);
  });

  it('keeps a backslash-escaped trailing space as part of the filename', () => {
    // The pattern line is `trailing\ ` — one escaped, significant trailing space.
    expect(ignores(['trailing\\ '], 'trailing ')).toBe(true);
    expect(ignores(['trailing\\ '], 'trailing')).toBe(false);
  });

  it('unescapes a leading \\# into a literal # rather than a comment', () => {
    const rule = compileRule('\\#hidden', '', 'test:1');
    expect(rule).not.toBeNull();
    expect(rule!.negated).toBe(false);
    expect(ignores(['\\#hidden'], '#hidden')).toBe(true);
    expect(ignores(['\\#hidden'], '\\#hidden')).toBe(false);
  });

  it('unescapes a leading \\! into a literal ! rather than a negation', () => {
    const rule = compileRule('\\!important.txt', '', 'test:1');
    expect(rule).not.toBeNull();
    expect(rule!.negated).toBe(false);
    expect(ignores(['\\!important.txt'], '!important.txt')).toBe(true);
    expect(ignores(['\\!important.txt'], 'important.txt')).toBe(false);
  });

  it('escapes a glob metacharacter so it matches only itself', () => {
    expect(ignores(['\\*.txt'], '*.txt')).toBe(true);
    expect(ignores(['\\*.txt'], 'notes.txt')).toBe(false);
  });

  it('compiles no rule from degenerate lines that are pure syntax', () => {
    expect(compileRule('!', '', 'test:1')).toBeNull();
    expect(compileRule('/', '', 'test:1')).toBeNull();
    expect(compileRule('!/', '', 'test:1')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anchoring
// ---------------------------------------------------------------------------

describe('anchoring', () => {
  it('anchors a pattern with a leading slash to the base directory only', () => {
    expect(ignores(['/foo'], 'foo')).toBe(true);
    expect(ignores(['/foo'], 'foo/bar')).toBe(true);
    expect(ignores(['/foo'], 'a/foo')).toBe(false);
  });

  it('anchors doc/frotz because it contains a slash', () => {
    expect(ignores(['doc/frotz'], 'doc/frotz')).toBe(true);
    expect(ignores(['doc/frotz'], 'doc/frotz/nested.txt')).toBe(true);
    expect(ignores(['doc/frotz'], 'a/doc/frotz')).toBe(false);
  });

  it('matches a slashless pattern like frotz at any depth', () => {
    expect(ignores(['frotz'], 'frotz')).toBe(true);
    expect(ignores(['frotz'], 'a/frotz')).toBe(true);
    expect(ignores(['frotz'], 'a/doc/frotz')).toBe(true);
    expect(ignores(['frotz'], 'a/frotz/deep.txt')).toBe(true);
  });

  it('matches whole path segments only, never a prefix or suffix of one', () => {
    expect(ignores(['frotz'], 'frotzy')).toBe(false);
    expect(ignores(['frotz'], 'unfrotz')).toBe(false);
    expect(ignores(['frotz'], 'a/frotzy/x')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Wildcards
// ---------------------------------------------------------------------------

describe('* and ?', () => {
  it('does not let * cross a directory separator', () => {
    expect(ignores(['src/*.ts'], 'src/a.ts')).toBe(true);
    expect(ignores(['src/*.ts'], 'src/nested/a.ts')).toBe(false);
  });

  it('does not let ? cross a directory separator', () => {
    expect(ignores(['a?c'], 'abc')).toBe(true);
    expect(ignores(['a?c'], 'ac')).toBe(false);
    expect(ignores(['a?c'], 'a/c')).toBe(false);
  });

  it('applies an unanchored * pattern at every depth', () => {
    expect(ignores(['*.log'], 'debug.log')).toBe(true);
    expect(ignores(['*.log'], 'a/b/debug.log')).toBe(true);
    expect(ignores(['*.log'], 'debug.logger')).toBe(false);
  });

  it('ignores everything under a directory a * pattern matched', () => {
    expect(ignores(['*.egg-info'], 'pkg.egg-info/PKG-INFO')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Globstar
// ---------------------------------------------------------------------------

describe('**', () => {
  it('matches at any depth when leading, including depth zero', () => {
    expect(ignores(['**/foo'], 'foo')).toBe(true);
    expect(ignores(['**/foo'], 'a/foo')).toBe(true);
    expect(ignores(['**/foo'], 'a/b/foo')).toBe(true);
    expect(ignores(['**/foo'], 'a/xfoo')).toBe(false);
  });

  it('matches everything beneath a directory when trailing, but not the directory itself', () => {
    expect(ignores(['a/**'], 'a/b')).toBe(true);
    expect(ignores(['a/**'], 'a/b/c')).toBe(true);
    expect(ignores(['a/**'], 'a', true)).toBe(false);
    expect(ignores(['a/**'], 'ab/c')).toBe(false);
  });

  it('matches zero or more intermediate directories when interior', () => {
    expect(ignores(['a/**/b'], 'a/b')).toBe(true);
    expect(ignores(['a/**/b'], 'a/x/b')).toBe(true);
    expect(ignores(['a/**/b'], 'a/x/y/b')).toBe(true);
    expect(ignores(['a/**/b'], 'b')).toBe(false);
    expect(ignores(['a/**/b'], 'x/a/b')).toBe(false);
  });

  it('collapses a repeated globstar rather than requiring extra directories', () => {
    expect(ignores(['a/**/**/b'], 'a/b')).toBe(true);
    expect(ignores(['a/**/**/b'], 'a/x/b')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Character classes
// ---------------------------------------------------------------------------

describe('character classes', () => {
  it('matches any listed character with [abc]', () => {
    expect(ignores(['[abc].txt'], 'a.txt')).toBe(true);
    expect(ignores(['[abc].txt'], 'c.txt')).toBe(true);
    expect(ignores(['[abc].txt'], 'd.txt')).toBe(false);
  });

  it('matches a range with [a-z]', () => {
    expect(ignores(['tmp[a-z]'], 'tmpq')).toBe(true);
    expect(ignores(['tmp[a-z]'], 'tmpQ')).toBe(false);
    expect(ignores(['tmp[a-z]'], 'tmp1')).toBe(false);
  });

  it('negates with [!abc]', () => {
    expect(ignores(['[!abc].txt'], 'd.txt')).toBe(true);
    expect(ignores(['[!abc].txt'], 'a.txt')).toBe(false);
  });

  it('never lets a negated class swallow a directory separator', () => {
    expect(ignores(['x[!a]y'], 'xby')).toBe(true);
    expect(ignores(['x[!a]y'], 'x/y')).toBe(false);
  });

  it('treats a ] immediately after [ as a literal member of the class', () => {
    expect(ignores(['[]x]'], ']')).toBe(true);
    expect(ignores(['[]x]'], 'x')).toBe(true);
    expect(ignores(['[]x]'], 'y')).toBe(false);
  });

  it('treats a ] immediately after [! as a literal member of the negated class', () => {
    expect(ignores(['[!]x]'], 'y')).toBe(true);
    expect(ignores(['[!]x]'], ']')).toBe(false);
    expect(ignores(['[!]x]'], 'x')).toBe(false);
  });

  it('treats an unterminated [ as a literal bracket', () => {
    expect(ignores(['foo[bar'], 'foo[bar')).toBe(true);
    expect(ignores(['foo[bar'], 'foob')).toBe(false);
    expect(ignores(['foo[bar'], 'fooa')).toBe(false);
  });

  it('treats an empty class [] as literal brackets rather than compiling nothing', () => {
    expect(ignores(['a[]'], 'a[]')).toBe(true);
  });

  // Regression test. An out-of-order character-class range (`[z-a]`, `[b-a]`, `[!z-a]`)
  // is legal to write in a `.gitignore` and illegal to hand to `RegExp`, which throws
  // `SyntaxError: ... Range out of order in character class`. `compileRule` used to let
  // that escape, and it runs from the Repository constructor via `buildIgnoreMatcher`
  // with no try/catch, so one stray line made every timeloom command crash. It is now
  // caught and the pattern dropped, matching git's wildmatch (a malformed range matches
  // nothing). Both halves matter: it must not throw, and it must not start matching.
  it('does not crash on a malformed out-of-order range in a user ignore file', () => {
    expect(() => rooted(['[z-a].txt'])).not.toThrow();
    expect(ignores(['[z-a].txt'], 'a.txt')).toBe(false);
  });

  // Regression test for the more damaging half of the same defect. `addPatterns`
  // compiles and pushes rules one at a time, so a throw on line 2 left line 1 applied
  // and line 3 silently discarded. In the scanner that throw is swallowed by the catch
  // around `addIgnoreFile`, and the directory is already in `loadedIgnoreFiles`, so it
  // is never retried — `secret.key` stopped being ignored with no error anywhere. A
  // pattern that fails to compile must not take the rest of the file down with it.
  it('keeps applying the patterns that follow a malformed one', () => {
    const matcher = new IgnoreMatcher().addPatterns(
      '',
      ['*.log', '[z-a].txt', 'secret.key'],
      '.gitignore',
    );
    expect(matcher.isIgnored('a.log', false)).toBe(true);
    expect(matcher.isIgnored('secret.key', false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Directory-only patterns
// ---------------------------------------------------------------------------

describe('trailing slash', () => {
  it('restricts a pattern to directories, sparing a file of the same name', () => {
    const matcher = rooted(['logs/']);
    expect(matcher.decideDirect('logs', true).ignored).toBe(true);
    expect(matcher.decideDirect('logs', false).ignored).toBe(false);
  });

  it('still excludes the contents of a directory it matched', () => {
    expect(ignores(['logs/'], 'logs/today.txt')).toBe(true);
    expect(ignores(['logs/'], 'a/logs/today.txt')).toBe(true);
  });

  it('matches both files and directories when the trailing slash is absent', () => {
    const matcher = rooted(['logs']);
    expect(matcher.decideDirect('logs', true).ignored).toBe(true);
    expect(matcher.decideDirect('logs', false).ignored).toBe(true);
  });

  it('records dirOnly on the compiled rule', () => {
    expect(compileRule('logs/', '', 'test:1')!.dirOnly).toBe(true);
    expect(compileRule('logs', '', 'test:1')!.dirOnly).toBe(false);
    expect(compileRule('!logs/', '', 'test:1')!.dirOnly).toBe(true);
    expect(compileRule('!logs/', '', 'test:1')!.negated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negation
// ---------------------------------------------------------------------------

describe('negation and last-match-wins', () => {
  it('re-includes a file when the negation comes after the exclusion', () => {
    expect(ignores(['*.log', '!important.log'], 'important.log')).toBe(false);
    expect(ignores(['*.log', '!important.log'], 'other.log')).toBe(true);
  });

  it('lets a later exclusion beat an earlier negation, because the last match wins', () => {
    expect(ignores(['!important.log', '*.log'], 'important.log')).toBe(true);
  });

  it('supports the exclude-everything-then-allowlist idiom', () => {
    const patterns = ['/*', '!/keep'];
    expect(ignores(patterns, 'keep')).toBe(false);
    expect(ignores(patterns, 'keep/nested/file.txt')).toBe(false);
    expect(ignores(patterns, 'other')).toBe(true);
    expect(ignores(patterns, 'other/file.txt')).toBe(true);
  });

  it('marks a negated rule as negated on the compiled rule', () => {
    expect(compileRule('!keep.log', '', 'test:1')!.negated).toBe(true);
    expect(compileRule('keep.log', '', 'test:1')!.negated).toBe(false);
  });
});

describe('a file under an excluded directory cannot be re-included', () => {
  const patterns = ['build/', '!build/keep.txt'];

  it('reports the file as ignored via its excluded ancestor', () => {
    const matcher = rooted(patterns);
    const decision = matcher.decide('build/keep.txt', false);
    expect(decision.ignored).toBe(true);
    expect(decision.viaAncestor).toBe('build');
    expect(decision.rule?.pattern).toBe('build/');
  });

  it('deliberately does not perform the ancestor walk in decideDirect', () => {
    // The walker prunes ignored directories before descending, so decideDirect can
    // (and must, for speed) trust that it is never asked about a pruned subtree.
    const decision = rooted(patterns).decideDirect('build/keep.txt', false);
    expect(decision.ignored).toBe(false);
    expect(decision.viaAncestor).toBeNull();
    expect(decision.rule?.pattern).toBe('!build/keep.txt');
  });

  it('honours re-inclusion when the exclusion used dir/** instead of dir/', () => {
    // `secrets/**` never matches `secrets` itself, so the ancestor stays included
    // and the negation can take effect. This is the documented escape hatch.
    const alt = ['secrets/**', '!secrets/README.md'];
    expect(ignores(alt, 'secrets', true)).toBe(false);
    expect(ignores(alt, 'secrets/README.md')).toBe(false);
    expect(ignores(alt, 'secrets/key.pem')).toBe(true);
  });

  it('reports viaAncestor as the deepest excluded ancestor, not the shallowest path', () => {
    const decision = rooted(['a/**']).decide('a/b/c.txt', false);
    expect(decision.ignored).toBe(true);
    expect(decision.viaAncestor).toBe('a/b');
  });

  it('leaves viaAncestor null when the path itself was the deciding match', () => {
    const decision = rooted(['*.log']).decide('a/b/debug.log', false);
    expect(decision.ignored).toBe(true);
    expect(decision.viaAncestor).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Base-scoped layering
// ---------------------------------------------------------------------------

describe('base-scoped rules', () => {
  it('applies rules from a nested ignore file only to paths inside that directory', () => {
    const matcher = new IgnoreMatcher().addPatterns('sub', ['secret.txt'], 'sub/.gitignore');
    expect(matcher.isIgnored('sub/secret.txt', false)).toBe(true);
    expect(matcher.isIgnored('sub/deep/secret.txt', false)).toBe(true);
    expect(matcher.isIgnored('secret.txt', false)).toBe(false);
    expect(matcher.isIgnored('other/secret.txt', false)).toBe(false);
  });

  it('does not leak into a sibling directory whose name merely starts with the base', () => {
    const matcher = new IgnoreMatcher().addPatterns('sub', ['secret.txt'], 'sub/.gitignore');
    expect(matcher.isIgnored('subdir/secret.txt', false)).toBe(false);
    expect(matcher.isIgnored('subterfuge/a/secret.txt', false)).toBe(false);
  });

  it('cannot reach outside its base with a parent-directory pattern', () => {
    // Paths handed to the matcher are repo-relative and normalised, so `..` in a
    // nested ignore file is inert rather than an escape hatch.
    const matcher = new IgnoreMatcher()
      .addPatterns('', ['*.log'], 'built-in')
      .addPatterns('sub', ['!../*.log'], 'sub/.gitignore');
    expect(matcher.isIgnored('a.log', false)).toBe(true);
    expect(matcher.isIgnored('sub/a.log', false)).toBe(true);
  });

  it('never applies a nested rule to the directory that hosts the ignore file', () => {
    // `a/b/.gitignore` cannot ignore `a/b` — git resolves patterns inside the
    // directory, not against it.
    const matcher = new IgnoreMatcher().addPatterns('sub', ['sub'], 'sub/.gitignore');
    expect(matcher.isIgnored('sub', true)).toBe(false);
    expect(matcher.isIgnored('sub/sub', true)).toBe(true);
  });

  it('lets a deeper base override a shallower one', () => {
    const matcher = new IgnoreMatcher()
      .addPatterns('', ['*.tmp'], 'built-in')
      .addPatterns('a', ['!*.tmp'], 'a/.gitignore')
      .addPatterns('a/b', ['*.tmp'], 'a/b/.gitignore');
    expect(matcher.isIgnored('x.tmp', false)).toBe(true);
    expect(matcher.isIgnored('a/x.tmp', false)).toBe(false);
    expect(matcher.isIgnored('a/c/x.tmp', false)).toBe(false);
    expect(matcher.isIgnored('a/b/x.tmp', false)).toBe(true);
    expect(matcher.isIgnored('a/b/c/x.tmp', false)).toBe(true);
  });

  it('gives the same answers whatever order the bases were registered in', () => {
    const shallowFirst = new IgnoreMatcher()
      .addPatterns('', ['*.tmp'], 'built-in')
      .addPatterns('a', ['!*.tmp'], 'a/.gitignore')
      .addPatterns('a/b', ['*.tmp'], 'a/b/.gitignore');
    const deepFirst = new IgnoreMatcher()
      .addPatterns('a/b', ['*.tmp'], 'a/b/.gitignore')
      .addPatterns('a', ['!*.tmp'], 'a/.gitignore')
      .addPatterns('', ['*.tmp'], 'built-in');
    for (const path of ['x.tmp', 'a/x.tmp', 'a/b/x.tmp', 'a/c/x.tmp', 'a/b/c/x.tmp', 'a/x.txt']) {
      expect([path, deepFirst.isIgnored(path, false)]).toEqual([
        path,
        shallowFirst.isIgnored(path, false),
      ]);
    }
  });

  it('normalises the base so leading and trailing slashes and "." all mean the root', () => {
    const matcher = new IgnoreMatcher()
      .addPatterns('.', ['a.txt'], 'root')
      .addPatterns('/sub/', ['b.txt'], 'sub');
    expect(matcher.isIgnored('a.txt', false)).toBe(true);
    expect(matcher.isIgnored('sub/b.txt', false)).toBe(true);
    expect(matcher.hasBase('')).toBe(true);
    expect(matcher.hasBase('sub')).toBe(true);
    expect(matcher.hasBase('/sub')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Final patterns
// ---------------------------------------------------------------------------

describe('addFinalPatterns', () => {
  it('re-includes a path that every base-scoped rule had excluded', () => {
    const matcher = new IgnoreMatcher()
      .addPatterns('', ['*.log'], 'built-in')
      .addPatterns('sub', ['keep.log'], 'sub/.gitignore')
      .addFinalPatterns(['!sub/keep.log'], 'config.ignore');
    expect(matcher.isIgnored('sub/keep.log', false)).toBe(false);
    expect(matcher.isIgnored('sub/other.log', false)).toBe(true);
  });

  it('excludes a path that a base-scoped rule had re-included', () => {
    const matcher = new IgnoreMatcher()
      .addPatterns('', ['*.log'], 'built-in')
      .addPatterns('sub', ['!keep.log'], 'sub/.gitignore')
      .addFinalPatterns(['sub/keep.log'], 'config.ignore');
    expect(matcher.isIgnored('sub/keep.log', false)).toBe(true);
  });

  it('wins regardless of when it was registered relative to the bases', () => {
    const matcher = new IgnoreMatcher()
      .addFinalPatterns(['!sub/keep.log'], 'config.ignore')
      .addPatterns('sub', ['*.log'], 'sub/.gitignore');
    expect(matcher.isIgnored('sub/keep.log', false)).toBe(false);
  });

  it('resolves its patterns against the project root, not against any base', () => {
    const matcher = new IgnoreMatcher().addFinalPatterns(['/keep.log'], 'config.ignore');
    expect(matcher.isIgnored('keep.log', false)).toBe(true);
    expect(matcher.isIgnored('sub/keep.log', false)).toBe(false);
  });

  it('can un-ignore a whole directory tree that a base rule had pruned', () => {
    const matcher = new IgnoreMatcher()
      .addPatterns('', ['vendor/'], 'built-in')
      .addFinalPatterns(['!vendor/'], 'config.ignore');
    expect(matcher.isIgnored('vendor', true)).toBe(false);
    expect(matcher.isIgnored('vendor/lib.js', false)).toBe(false);
  });

  it('does not register a bucket, so hasBase stays false', () => {
    const matcher = new IgnoreMatcher().addFinalPatterns(['*.log'], 'config.ignore');
    expect(matcher.hasBase('')).toBe(false);
    expect(matcher.ruleCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

describe('ignore-file bookkeeping', () => {
  const contents = '# comment\n\n*.log\nbuild/\n';

  it('reports an ignore file as loaded only after addIgnoreFile', () => {
    const matcher = new IgnoreMatcher();
    expect(matcher.hasIgnoreFile('sub')).toBe(false);
    matcher.addIgnoreFile('sub', contents, 'sub/.gitignore');
    expect(matcher.hasIgnoreFile('sub')).toBe(true);
    expect(matcher.hasIgnoreFile('other')).toBe(false);
  });

  it('does not treat plain addPatterns as having loaded an ignore file', () => {
    const matcher = new IgnoreMatcher().addPatterns('', DEFAULT_IGNORE, 'built-in');
    expect(matcher.hasBase('')).toBe(true);
    expect(matcher.hasIgnoreFile('')).toBe(false);
  });

  it('normalises the base when answering hasIgnoreFile', () => {
    const matcher = new IgnoreMatcher().addIgnoreFile('/sub/', contents, 'sub/.gitignore');
    expect(matcher.hasIgnoreFile('sub')).toBe(true);
    expect(matcher.hasIgnoreFile('sub/')).toBe(true);
    expect(matcher.hasIgnoreFile('/sub')).toBe(true);
  });

  it('treats "." and "" as the same base', () => {
    const matcher = new IgnoreMatcher().addIgnoreFile('.', contents, '.gitignore');
    expect(matcher.hasIgnoreFile('')).toBe(true);
  });

  it('lets a guarded re-scan re-add nothing, keeping the rule count stable', () => {
    // This is exactly the scanner's loop: the matcher outlives a single scan, so a
    // re-scan must not append the same rules again.
    const matcher = new IgnoreMatcher();
    for (let pass = 0; pass < 3; pass += 1) {
      if (!matcher.hasIgnoreFile('sub')) {
        matcher.addIgnoreFile('sub', contents, 'sub/.gitignore');
      }
    }
    expect(matcher.ruleCount).toBe(2);
  });

  it('counts only real patterns, skipping comments and blank lines', () => {
    expect(new IgnoreMatcher().addIgnoreFile('', contents, '.gitignore').ruleCount).toBe(2);
  });

  it('gives identical decisions if the same file is folded in twice', () => {
    const once = new IgnoreMatcher().addIgnoreFile('', contents, '.gitignore');
    const twice = new IgnoreMatcher()
      .addIgnoreFile('', contents, '.gitignore')
      .addIgnoreFile('', contents, '.gitignore');
    for (const path of ['a.log', 'build/x', 'src/main.ts', 'build']) {
      expect([path, twice.isIgnored(path, false)]).toEqual([path, once.isIgnored(path, false)]);
    }
    expect(twice.ruleCount).toBe(4);
  });

  it('applies the first pattern of an ignore file that begins with a BOM', () => {
    const matcher = new IgnoreMatcher().addIgnoreFile('', `${BOM}secret.key\n`, '.gitignore');
    expect(matcher.isIgnored('secret.key', false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decision reporting
// ---------------------------------------------------------------------------

describe('decision reporting', () => {
  it('names the rule that decided, with its source line', () => {
    const matcher = new IgnoreMatcher().addIgnoreFile('', '# c\n\nsecret.txt\n', '.gitignore');
    const decision = matcher.decide('secret.txt', false);
    expect(decision.ignored).toBe(true);
    expect(decision.rule?.source).toBe('.gitignore:3');
    expect(decision.rule?.pattern).toBe('secret.txt');
    expect(decision.rule?.base).toBe('');
  });

  it('names the last matching rule when several apply', () => {
    const decision = rooted(['*.log', '!keep.log']).decide('keep.log', false);
    expect(decision.ignored).toBe(false);
    expect(decision.rule?.pattern).toBe('!keep.log');
    expect(decision.rule?.source).toBe('test:2');
    expect(decision.viaAncestor).toBeNull();
  });

  it('records the base a nested rule came from', () => {
    const matcher = new IgnoreMatcher().addIgnoreFile('sub', 'secret.txt\n', 'sub/.gitignore');
    expect(matcher.decide('sub/secret.txt', false).rule?.base).toBe('sub');
  });

  it('returns a null rule and no ancestor when nothing matched', () => {
    const decision = rooted(['*.log']).decide('src/main.ts', false);
    expect(decision).toEqual({ ignored: false, rule: null, viaAncestor: null });
  });

  it('agrees with isIgnored', () => {
    const matcher = rooted(['build/', '*.log', '!keep.log']);
    for (const path of ['build/x.js', 'a.log', 'keep.log', 'src/main.ts']) {
      expect([path, matcher.isIgnored(path, false)]).toEqual([
        path,
        matcher.decide(path, false).ignored,
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// The shipped defaults
// ---------------------------------------------------------------------------

describe('DEFAULT_IGNORE', () => {
  const matcher = () => new IgnoreMatcher().addPatterns('', DEFAULT_IGNORE, 'built-in');

  it.each([
    'node_modules/anything',
    'dist/x.js',
    '.git/config',
    '__pycache__/x.pyc',
    '.timeloom/index.jsonl',
  ])('excludes %s', (path) => {
    expect(matcher().isIgnored(path, false)).toBe(true);
  });

  it.each(['src/index.ts', '.env'])('does not exclude %s', (path) => {
    expect(matcher().isIgnored(path, false)).toBe(false);
  });

  it('excludes a nested node_modules anywhere in a monorepo', () => {
    expect(matcher().isIgnored('packages/app/node_modules/lib/index.js', false)).toBe(true);
  });

  it('does not exclude directories that merely share a prefix with a default', () => {
    // A default that matched too eagerly would silently stop protecting real work.
    for (const path of [
      'distribution/notes.md',
      'my-node_modules/index.js',
      'builder/main.ts',
      'outfit/hat.png',
      'targets/list.json',
    ]) {
      expect([path, matcher().isIgnored(path, false)]).toEqual([path, false]);
    }
  });

  it('excludes a file named like a build directory only when it is a directory', () => {
    expect(matcher().decideDirect('dist', false).ignored).toBe(false);
    expect(matcher().decideDirect('dist', true).ignored).toBe(true);
  });
});
