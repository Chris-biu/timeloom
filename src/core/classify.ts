import type { ChangeKind } from '../types.js';

/**
 * Path-based classification of what a change touched.
 *
 * The point is not taxonomic precision. It is that "3 files changed" is useless to
 * someone deciding which snapshot to restore, whereas "styling, under
 * src/components" lets them recognise their own afternoon. Everything here is
 * derived from paths alone — no file contents are read, so classification costs
 * nothing on the snapshot hot path.
 */

const DEPENDENCY_FILES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'bun.lockb',
  'bun.lock',
  'requirements.txt',
  'requirements-dev.txt',
  'constraints.txt',
  'pyproject.toml',
  'poetry.lock',
  'uv.lock',
  'pipfile',
  'pipfile.lock',
  'cargo.toml',
  'cargo.lock',
  'go.mod',
  'go.sum',
  'gemfile',
  'gemfile.lock',
  'composer.json',
  'composer.lock',
  'pubspec.yaml',
  'pubspec.lock',
]);

const CONFIG_FILES = new Set([
  'dockerfile',
  'makefile',
  'procfile',
  'vercel.json',
  'netlify.toml',
  'railway.json',
  'fly.toml',
  'nginx.conf',
  '.npmrc',
  '.nvmrc',
  '.node-version',
  '.python-version',
  '.dockerignore',
  '.gitignore',
  '.gitattributes',
  '.editorconfig',
]);

const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less', '.styl', '.pcss']);

const ASSET_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.avif',
  '.bmp',
  '.ico',
  '.svg',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  '.mp3',
  '.wav',
  '.ogg',
  '.mp4',
  '.webm',
  '.mov',
  '.pdf',
  '.zip',
]);

const DOC_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc']);

const UI_EXTENSIONS = new Set(['.tsx', '.jsx', '.vue', '.svelte', '.astro', '.html', '.htm']);

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.js',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.kt',
  '.rb',
  '.php',
  '.cs',
  '.swift',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cc',
  '.sql',
  '.sh',
  '.bash',
  '.ps1',
  '.dart',
  '.ex',
  '.exs',
]);

const CONFIG_EXTENSIONS = new Set([
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.properties',
]);

const UI_DIRECTORIES = [
  'components',
  'component',
  'pages',
  'views',
  'screens',
  'layouts',
  'widgets',
  'ui',
];

const DOC_DIRECTORIES = ['docs', 'doc', 'documentation'];

const TEST_DIRECTORIES = ['test', 'tests', '__tests__', 'spec', 'specs', 'e2e', 'cypress'];

export function classifyPath(repoPath: string): ChangeKind | null {
  const lower = repoPath.toLowerCase();
  const segments = lower.split('/');
  const base = segments[segments.length - 1] ?? lower;
  const directories = segments.slice(0, -1);
  const dotIndex = base.lastIndexOf('.');
  // A leading dot is part of the name (`.env`), not an extension separator.
  const extension = dotIndex > 0 ? base.slice(dotIndex) : '';

  if (DEPENDENCY_FILES.has(base)) return 'deps';

  if (
    directories.some((segment) => TEST_DIRECTORIES.includes(segment)) ||
    /\.(test|spec)\./.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.(go|py|rb)$/.test(base)
  ) {
    return 'test';
  }

  if (
    DOC_EXTENSIONS.has(extension) ||
    directories.some((segment) => DOC_DIRECTORIES.includes(segment)) ||
    base === 'license' ||
    base === 'license.txt' ||
    base === 'notice'
  ) {
    return 'docs';
  }

  if (STYLE_EXTENSIONS.has(extension) || base.startsWith('tailwind.config.')) return 'style';

  if (ASSET_EXTENSIONS.has(extension)) return 'assets';

  if (
    CONFIG_FILES.has(base) ||
    CONFIG_EXTENSIONS.has(extension) ||
    directories[0] === '.github' ||
    base.startsWith('.env') ||
    base.startsWith('docker-compose') ||
    base.startsWith('tsconfig') ||
    base.startsWith('jsconfig') ||
    base.startsWith('.eslintrc') ||
    base.startsWith('.prettierrc') ||
    base.startsWith('.babelrc') ||
    /\.config\.(m|c)?[jt]s$/.test(base)
  ) {
    return 'config';
  }

  if (UI_EXTENSIONS.has(extension)) return 'ui';
  if (
    CODE_EXTENSIONS.has(extension) &&
    directories.some((segment) => UI_DIRECTORIES.includes(segment))
  ) {
    return 'ui';
  }
  if (CODE_EXTENSIONS.has(extension)) return 'logic';

  return null;
}

/**
 * The single kind that best describes a set of paths.
 *
 * A clear majority names the change; anything more scattered is honestly reported as
 * mixed rather than dressed up with a label the user would not recognise.
 */
const DOMINANCE_THRESHOLD = 0.6;

export function dominantKind(paths: readonly string[]): ChangeKind {
  if (paths.length === 0) return 'none';

  const votes = new Map<ChangeKind, number>();
  let classified = 0;
  for (const path of paths) {
    const kind = classifyPath(path);
    if (kind === null) continue;
    classified += 1;
    votes.set(kind, (votes.get(kind) ?? 0) + 1);
  }
  if (classified === 0) return 'mixed';

  let best: ChangeKind = 'mixed';
  let bestCount = 0;
  for (const [kind, count] of votes) {
    if (count > bestCount) {
      best = kind;
      bestCount = count;
    }
  }
  return bestCount / classified >= DOMINANCE_THRESHOLD ? best : 'mixed';
}

/** Deepest directory containing every path, or null when they share no parent. */
export function commonDirectory(paths: readonly string[]): string | null {
  if (paths.length === 0) return null;

  let prefix: string[] | null = null;
  for (const path of paths) {
    const segments = path.split('/').slice(0, -1);
    if (prefix === null) {
      prefix = segments;
      continue;
    }
    let shared = 0;
    while (
      shared < prefix.length &&
      shared < segments.length &&
      prefix[shared] === segments[shared]
    ) {
      shared += 1;
    }
    prefix = prefix.slice(0, shared);
    if (prefix.length === 0) return null;
  }

  return prefix === null || prefix.length === 0 ? null : prefix.join('/');
}
