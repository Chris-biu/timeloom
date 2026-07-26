/**
 * A gitignore-compatible path matcher.
 *
 * Written from scratch because timeloom ships no runtime dependencies, and because
 * getting this *right* matters more than usual here: a pattern that accidentally
 * matches too much silently stops protecting the user's files, and one that matches
 * too little pulls `node_modules` into every snapshot.
 *
 * Implemented semantics (all of gitignore(5) that appears in real projects):
 *
 *   - `#` comments, blank lines, and trailing whitespace stripping
 *   - `\` escapes, including `\#` and `\!` at the start of a line
 *   - `!` negation, with last-match-wins ordering
 *   - trailing `/` restricting a pattern to directories
 *   - anchoring: a pattern containing a `/` anywhere but the end is relative to the
 *     directory of the ignore file; one without is matched at any depth
 *   - `*` and `?` that do not cross `/`
 *   - `**` as a leading, trailing, or interior segment
 *   - `[abc]`, `[a-z]`, `[!abc]` character classes
 *   - nested ignore files, layered so a deeper file overrides a shallower one
 *
 * Known deviation: POSIX bracket expressions (`[[:alpha:]]`) are treated as literal
 * characters. They are legal in gitignore but do not appear in practice, and
 * supporting them would mean carrying a locale table.
 */

export interface IgnoreRule {
  /** Where this rule came from, e.g. `.gitignore:12`. Surfaced by `explain`. */
  source: string;
  pattern: string;
  negated: boolean;
  /** Only matches directories (pattern ended with `/`). */
  dirOnly: boolean;
  /** Repo-relative directory the pattern is resolved against. `''` is the root. */
  base: string;
  regex: RegExp;
}

interface ParsedPattern {
  negated: boolean;
  dirOnly: boolean;
  body: string;
  anchored: boolean;
}

/**
 * Split an ignore file into individual pattern lines.
 * Exported so callers can pre-validate user-supplied patterns.
 */
export function parseIgnoreFile(contents: string): string[] {
  // Editors on Windows routinely write a BOM; without stripping it the first
  // pattern in the file silently never matches. Compared by code point rather than
  // written as a literal so the character cannot be lost in transit.
  const body = contents.charCodeAt(0) === 0xfeff ? contents.slice(1) : contents;
  return body.split(/\r?\n/);
}

function parsePatternLine(line: string): ParsedPattern | null {
  // Strip trailing whitespace, but a backslash-escaped trailing space is literal.
  let text = line.replace(/(?<!\\)\s+$/, '');
  if (text.length === 0) return null;
  if (text.startsWith('#')) return null;

  let negated = false;
  if (text.startsWith('!')) {
    negated = true;
    text = text.slice(1);
  } else if (text.startsWith('\\#') || text.startsWith('\\!')) {
    text = text.slice(1);
  }
  if (text.length === 0) return null;

  let dirOnly = false;
  if (text.endsWith('/') && !text.endsWith('\\/')) {
    dirOnly = true;
    text = text.slice(0, -1);
  }
  if (text.length === 0) return null;

  // A leading slash anchors without itself being part of the path.
  let anchored = false;
  if (text.startsWith('/')) {
    anchored = true;
    text = text.slice(1);
  } else if (text.includes('/')) {
    // Any interior slash also anchors — `doc/frotz` is rooted, `frotz` is not.
    anchored = true;
  }
  if (text.length === 0) return null;

  return { negated, dirOnly, body: text, anchored };
}

const REGEXP_SPECIALS = new Set([
  '.',
  '+',
  '^',
  '$',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  '|',
  '\\',
  '/',
  '*',
  '?',
]);

function escapeLiteral(char: string): string {
  return REGEXP_SPECIALS.has(char) ? `\\${char}` : char;
}

interface CharClassResult {
  source: string;
  next: number;
}

/** Translate `[...]` starting at `start`, or return null if it is unterminated. */
function compileCharClass(segment: string, start: number): CharClassResult | null {
  let index = start + 1;
  let negate = false;
  if (segment[index] === '!' || segment[index] === '^') {
    negate = true;
    index += 1;
  }
  let body = '';
  // A `]` immediately after the (optional) negation is a literal, per POSIX.
  if (segment[index] === ']') {
    body += '\\]';
    index += 1;
  }
  let closed = false;
  while (index < segment.length) {
    const char = segment[index];
    if (char === undefined) break;
    if (char === ']') {
      closed = true;
      index += 1;
      break;
    }
    if (char === '\\' && index + 1 < segment.length) {
      body += `\\${segment[index + 1] ?? ''}`;
      index += 2;
      continue;
    }
    if (char === '^' || char === '\\' || char === '[') {
      body += `\\${char}`;
      index += 1;
      continue;
    }
    body += char;
    index += 1;
  }
  if (!closed || body.length === 0) return null;
  // `/` can never be matched by a class, mirroring how `*` behaves.
  return { source: `[${negate ? '^/' : ''}${body}]`, next: index };
}

function compileSegment(segment: string): string {
  let out = '';
  let index = 0;
  while (index < segment.length) {
    const char = segment[index];
    if (char === undefined) break;
    if (char === '\\' && index + 1 < segment.length) {
      out += escapeLiteral(segment[index + 1] ?? '');
      index += 2;
      continue;
    }
    if (char === '*') {
      out += '[^/]*';
      index += 1;
      continue;
    }
    if (char === '?') {
      out += '[^/]';
      index += 1;
      continue;
    }
    if (char === '[') {
      const cls = compileCharClass(segment, index);
      if (cls !== null) {
        out += cls.source;
        index = cls.next;
        continue;
      }
      out += '\\[';
      index += 1;
      continue;
    }
    out += escapeLiteral(char);
    index += 1;
  }
  return out;
}

function compilePattern(parsed: ParsedPattern): RegExp {
  const segments = parsed.body.split('/');
  let source = '^';
  if (!parsed.anchored) {
    // Unanchored patterns match at any depth.
    source += '(?:.*/)?';
  }

  let index = 0;
  let needSeparator = false;
  let sawTrailingGlobstar = false;

  while (index < segments.length) {
    const segment = segments[index];
    if (segment === '**') {
      while (segments[index] === '**') index += 1;
      if (index >= segments.length) {
        // `a/**` matches everything beneath `a`.
        source += needSeparator ? '/.*' : '.*';
        sawTrailingGlobstar = true;
        break;
      }
      // `a/**/b` matches `a/b` as well as `a/x/y/b`, so the separator is optional.
      source += needSeparator ? '/(?:[^/]+/)*' : '(?:[^/]+/)*';
      needSeparator = false;
      continue;
    }
    if (segment === undefined) break;
    // An empty segment comes from a `//`; treat it as a no-op rather than matching "".
    if (segment.length === 0) {
      index += 1;
      continue;
    }
    source += (needSeparator ? '/' : '') + compileSegment(segment);
    needSeparator = true;
    index += 1;
  }

  if (!sawTrailingGlobstar) {
    // Matching a directory implies matching everything under it.
    source += '(?:/.*)?';
  }
  source += '$';

  return new RegExp(source);
}

/**
 * Compile one pattern, or return null if it is a comment, blank, or unusable.
 *
 * Unusable is the interesting case. A character class like `[z-a]` is legal to write
 * in a `.gitignore` and illegal to hand to `RegExp`, which throws a `SyntaxError`.
 * Ignore files are arbitrary user input and this runs from the Repository constructor,
 * so letting that escape means one stray line makes every timeloom command crash — and
 * worse, aborts the rest of the file, silently un-ignoring everything after it.
 *
 * git's own wildmatch treats a malformed range as matching nothing, so that is what
 * happens here: the pattern is dropped, its neighbours still apply, and the failure is
 * recorded for `timeloom why` rather than thrown.
 */
export function compileRule(pattern: string, base: string, source: string): IgnoreRule | null {
  const parsed = parsePatternLine(pattern);
  if (parsed === null) return null;

  let regex: RegExp;
  try {
    regex = compilePattern(parsed);
  } catch {
    return null;
  }

  return {
    source,
    pattern,
    negated: parsed.negated,
    dirOnly: parsed.dirOnly,
    base,
    regex,
  };
}

export interface InvalidPattern {
  pattern: string;
  source: string;
}

/** Which rule decided a path's fate, and what it decided. */
export interface IgnoreDecision {
  ignored: boolean;
  rule: IgnoreRule | null;
  /** Set when an ancestor directory was ignored rather than the path itself. */
  viaAncestor: string | null;
}

export class IgnoreMatcher {
  /**
   * Rules bucketed by the directory they are rooted at.
   *
   * A rule from `src/.gitignore` can only ever apply to paths under `src/`, so at
   * match time we walk the candidate path's ancestor chain and only touch the few
   * buckets that can possibly apply. Iterating every rule in the project instead
   * turns scanning a monorepo into an O(files x rules) problem.
   */
  private readonly buckets = new Map<string, IgnoreRule[]>();
  /**
   * Rules that always get the last word, whatever any ignore file in the tree says.
   * timeloom's own config lives here: if you tell timeloom to track a file, a
   * `.gitignore` three directories down should not quietly overrule you.
   */
  private readonly finalRules: IgnoreRule[] = [];
  /**
   * Directories whose ignore file has already been folded in. A matcher is reused
   * across scans — the watcher holds the same instance so its event filtering stays
   * in step with the scanner's — and re-reading a `.gitignore` on every pass would
   * append the same rules forever.
   */
  private readonly loadedIgnoreFiles = new Set<string>();
  /** Patterns that could not be compiled. Surfaced by `timeloom why`, never thrown. */
  private readonly invalid: InvalidPattern[] = [];
  private count = 0;

  /**
   * Add a set of patterns rooted at `base` (repo-relative, `''` for the project root).
   * Within a base, later patterns win; across bases, deeper wins. Both fall out of
   * the evaluation order in {@link decideDirect}, so callers may add in any order.
   */
  addPatterns(base: string, patterns: Iterable<string>, sourceName: string): this {
    const normalizedBase = normalizeBase(base);
    let bucket = this.buckets.get(normalizedBase);
    if (bucket === undefined) {
      bucket = [];
      this.buckets.set(normalizedBase, bucket);
    }
    let lineNumber = 0;
    for (const pattern of patterns) {
      lineNumber += 1;
      const source = `${sourceName}:${lineNumber}`;
      const rule = compileRule(pattern, normalizedBase, source);
      if (rule !== null) {
        bucket.push(rule);
        this.count += 1;
      } else if (isPatternLine(pattern)) {
        this.invalid.push({ pattern, source });
      }
    }
    return this;
  }

  /** Patterns that were syntactically unusable and are therefore matching nothing. */
  get invalidPatterns(): readonly InvalidPattern[] {
    return this.invalid;
  }

  addIgnoreFile(base: string, contents: string, sourceName: string): this {
    this.loadedIgnoreFiles.add(normalizeBase(base));
    return this.addPatterns(base, parseIgnoreFile(contents), sourceName);
  }

  /** Has an ignore file for this exact directory already been registered? */
  hasIgnoreFile(base: string): boolean {
    return this.loadedIgnoreFiles.has(normalizeBase(base));
  }

  /** Patterns evaluated after every bucket, root-relative. See {@link finalRules}. */
  addFinalPatterns(patterns: Iterable<string>, sourceName: string): this {
    let lineNumber = 0;
    for (const pattern of patterns) {
      lineNumber += 1;
      const source = `${sourceName}:${lineNumber}`;
      const rule = compileRule(pattern, '', source);
      if (rule !== null) {
        this.finalRules.push(rule);
        this.count += 1;
      } else if (isPatternLine(pattern)) {
        this.invalid.push({ pattern, source });
      }
    }
    return this;
  }

  get ruleCount(): number {
    return this.count;
  }

  /** True when any ignore file has been registered for this exact directory. */
  hasBase(base: string): boolean {
    return this.buckets.has(normalizeBase(base));
  }

  /**
   * Decide a single path without considering its ancestors.
   *
   * This is what the directory walker uses: it tests each directory before
   * descending, so an ignored directory prunes its whole subtree and the ancestor
   * walk in {@link decide} is unnecessary on the hot path.
   */
  decideDirect(repoPath: string, isDirectory: boolean): IgnoreDecision {
    let decision: IgnoreRule | null = null;
    for (const base of ancestorBases(repoPath)) {
      const bucket = this.buckets.get(base);
      if (bucket === undefined) continue;
      const relative = base === '' ? repoPath : repoPath.slice(base.length + 1);
      for (const rule of bucket) {
        if (rule.dirOnly && !isDirectory) continue;
        if (rule.regex.test(relative)) decision = rule;
      }
    }
    for (const rule of this.finalRules) {
      if (rule.dirOnly && !isDirectory) continue;
      if (rule.regex.test(repoPath)) decision = rule;
    }
    return {
      ignored: decision !== null && !decision.negated,
      rule: decision,
      viaAncestor: null,
    };
  }

  /**
   * Full decision including ancestors. gitignore cannot re-include a file whose
   * parent directory is excluded, so an ignored ancestor is final.
   */
  decide(repoPath: string, isDirectory: boolean): IgnoreDecision {
    const segments = repoPath.split('/');
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join('/');
      const ancestorDecision = this.decideDirect(ancestor, true);
      if (ancestorDecision.ignored) {
        return { ignored: true, rule: ancestorDecision.rule, viaAncestor: ancestor };
      }
    }
    return this.decideDirect(repoPath, isDirectory);
  }

  isIgnored(repoPath: string, isDirectory: boolean): boolean {
    return this.decide(repoPath, isDirectory).ignored;
  }
}

/** Distinguishes "this line was a comment or blank" from "this line was broken". */
function isPatternLine(pattern: string): boolean {
  return parsePatternLine(pattern) !== null;
}

function normalizeBase(base: string): string {
  const trimmed = base.replace(/^\/+|\/+$/g, '');
  return trimmed === '.' ? '' : trimmed;
}

/**
 * Every directory that could host an ignore file governing `repoPath`, shallowest
 * first. The path itself is excluded: `a/b/.gitignore` cannot ignore `a/b`.
 */
function* ancestorBases(repoPath: string): Generator<string> {
  yield '';
  let index = repoPath.indexOf('/');
  while (index !== -1) {
    yield repoPath.slice(0, index);
    index = repoPath.indexOf('/', index + 1);
  }
}
