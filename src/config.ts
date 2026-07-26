import { TimeloomError } from './errors.js';
import { repoPaths } from './paths.js';
import { readJsonFile, writeJsonFile } from './util/fsx.js';
import { ValidationError, Validator } from './util/validate.js';

export const LANGUAGES = ['en', 'zh-CN'] as const;
export type Language = (typeof LANGUAGES)[number];

export interface WatchConfig {
  /**
   * How long the tree must stay still before a snapshot is taken. An AI agent
   * rewriting a dozen files should produce one snapshot, not a dozen.
   */
  quietPeriodMs: number;
  /** Upper bound on debouncing, so a continuously-churning tree still gets snapshots. */
  maxWaitMs: number;
  /**
   * Native recursive watchers drop events under load and on network drives. A
   * periodic full rescan is the safety net; 0 disables it.
   */
  reconcileIntervalMs: number;
}

export interface HealthConfig {
  enabled: boolean;
  /** Shell command whose exit code decides whether a snapshot is "working". */
  command: string | null;
  timeoutMs: number;
  successExitCodes: number[];
  /** Never probe more often than this, however fast snapshots arrive. */
  minIntervalMs: number;
}

export interface RetentionConfig {
  keepAllWithinMinutes: number;
  hourlyForHours: number;
  dailyForDays: number;
  weeklyForWeeks: number;
  /** Hard ceiling. Oldest unpinned snapshots go first once exceeded. */
  maxSnapshots: number;
}

export interface ServerConfig {
  /** Loopback only. Binding elsewhere would expose your source tree to the network. */
  host: string;
  port: number;
}

export interface TimeloomConfig {
  version: 1;
  /** Extra gitignore-syntax patterns, applied on top of the built-in defaults. */
  ignore: string[];
  /** Honour the project's own .gitignore files as well. */
  useGitignore: boolean;
  /** Files larger than this are not tracked at all. Keeps the store from exploding. */
  maxFileBytes: number;
  watch: WatchConfig;
  health: HealthConfig;
  retention: RetentionConfig;
  server: ServerConfig;
  language: Language;
}

/**
 * Directories and files that are build output, dependency caches, or editor state.
 * None of them are worth snapshotting and all of them are enormous.
 */
export const DEFAULT_IGNORE: readonly string[] = [
  '.timeloom/',
  '.git/',
  '.hg/',
  '.svn/',

  // JavaScript / TypeScript
  'node_modules/',
  'bower_components/',
  '.pnpm-store/',
  '.yarn/cache/',
  '.yarn/unplugged/',
  'dist/',
  'build/',
  'out/',
  '.next/',
  '.nuxt/',
  '.svelte-kit/',
  '.astro/',
  '.turbo/',
  '.parcel-cache/',
  '.vite/',
  'storybook-static/',

  // Python
  '__pycache__/',
  '.venv/',
  'venv/',
  'env/',
  '.tox/',
  '.pytest_cache/',
  '.mypy_cache/',
  '.ruff_cache/',
  '*.egg-info/',
  '*.pyc',
  '*.pyo',

  // Other toolchains
  'target/',
  'vendor/',
  '.gradle/',
  'Pods/',
  '.dart_tool/',
  '.terraform/',

  // Hosting / mobile
  '.vercel/',
  '.netlify/',
  '.expo/',
  '.serverless/',

  // Test + coverage output
  'coverage/',
  '.nyc_output/',
  'playwright-report/',
  'test-results/',

  // Editors and OS junk
  '.idea/',
  '.DS_Store',
  'Thumbs.db',
  '*.swp',
  '*~',

  // Logs and binaries
  '*.log',
  '*.class',
  '*.o',
  '*.so',
  '*.dylib',
  '*.dll',
  '*.exe',
  '*.pdb',
];

export function defaultConfig(language: Language = detectLanguage()): TimeloomConfig {
  return {
    version: 1,
    ignore: [],
    useGitignore: true,
    maxFileBytes: 5 * 1024 * 1024,
    watch: {
      quietPeriodMs: 3_000,
      maxWaitMs: 45_000,
      reconcileIntervalMs: 5 * 60_000,
    },
    health: {
      enabled: false,
      command: null,
      timeoutMs: 120_000,
      successExitCodes: [0],
      minIntervalMs: 60_000,
    },
    retention: {
      keepAllWithinMinutes: 60,
      hourlyForHours: 24,
      dailyForDays: 14,
      weeklyForWeeks: 8,
      maxSnapshots: 2_000,
    },
    server: {
      host: '127.0.0.1',
      port: 7317,
    },
    language,
  };
}

/** Best-effort locale sniff so a Chinese-locale user gets Chinese output by default. */
export function detectLanguage(env: NodeJS.ProcessEnv = process.env): Language {
  const raw = env['TIMELOOM_LANG'] ?? env['LC_ALL'] ?? env['LC_MESSAGES'] ?? env['LANG'] ?? '';
  return /^zh/i.test(raw) ? 'zh-CN' : 'en';
}

const WATCH_KEYS = ['quietPeriodMs', 'maxWaitMs', 'reconcileIntervalMs'] as const;
const HEALTH_KEYS = [
  'enabled',
  'command',
  'timeoutMs',
  'successExitCodes',
  'minIntervalMs',
] as const;
const RETENTION_KEYS = [
  'keepAllWithinMinutes',
  'hourlyForHours',
  'dailyForDays',
  'weeklyForWeeks',
  'maxSnapshots',
] as const;
const SERVER_KEYS = ['host', 'port'] as const;
const ROOT_KEYS = [
  'version',
  'ignore',
  'useGitignore',
  'maxFileBytes',
  'watch',
  'health',
  'retention',
  'server',
  'language',
] as const;

const MINUTE = 60_000;
const DAY = 24 * 60;

/**
 * Merge user config over defaults, validating as we go.
 *
 * Invalid individual fields fall back to their default *and* record an issue, so a
 * single typo reports every problem in the file at once instead of one per run.
 */
export function parseConfig(input: unknown): TimeloomConfig {
  const base = defaultConfig();
  if (input === null || input === undefined) return base;

  const v = new Validator();
  const root = v.object('config', input);
  if (root === null) {
    v.throwIfInvalid();
    return base;
  }
  v.noUnknownKeys('config', root, ROOT_KEYS);

  const watchRaw =
    root['watch'] === undefined ? {} : (v.object('config.watch', root['watch']) ?? {});
  v.noUnknownKeys('config.watch', watchRaw, WATCH_KEYS);

  const healthRaw =
    root['health'] === undefined ? {} : (v.object('config.health', root['health']) ?? {});
  v.noUnknownKeys('config.health', healthRaw, HEALTH_KEYS);

  const retentionRaw =
    root['retention'] === undefined ? {} : (v.object('config.retention', root['retention']) ?? {});
  v.noUnknownKeys('config.retention', retentionRaw, RETENTION_KEYS);

  const serverRaw =
    root['server'] === undefined ? {} : (v.object('config.server', root['server']) ?? {});
  v.noUnknownKeys('config.server', serverRaw, SERVER_KEYS);

  const config: TimeloomConfig = {
    version: 1,
    ignore: v.stringArray('config.ignore', root['ignore'], base.ignore),
    useGitignore: v.boolean('config.useGitignore', root['useGitignore'], base.useGitignore),
    maxFileBytes: v.integer(
      'config.maxFileBytes',
      root['maxFileBytes'],
      base.maxFileBytes,
      1_024,
      2 * 1024 * 1024 * 1024,
    ),
    watch: {
      quietPeriodMs: v.integer(
        'config.watch.quietPeriodMs',
        watchRaw['quietPeriodMs'],
        base.watch.quietPeriodMs,
        100,
        10 * MINUTE,
      ),
      maxWaitMs: v.integer(
        'config.watch.maxWaitMs',
        watchRaw['maxWaitMs'],
        base.watch.maxWaitMs,
        1_000,
        60 * MINUTE,
      ),
      reconcileIntervalMs: v.integer(
        'config.watch.reconcileIntervalMs',
        watchRaw['reconcileIntervalMs'],
        base.watch.reconcileIntervalMs,
        0,
        24 * 60 * MINUTE,
      ),
    },
    health: {
      enabled: v.boolean('config.health.enabled', healthRaw['enabled'], base.health.enabled),
      command: v.nullableString('config.health.command', healthRaw['command'], base.health.command),
      timeoutMs: v.integer(
        'config.health.timeoutMs',
        healthRaw['timeoutMs'],
        base.health.timeoutMs,
        1_000,
        60 * MINUTE,
      ),
      successExitCodes: v.integerArray(
        'config.health.successExitCodes',
        healthRaw['successExitCodes'],
        base.health.successExitCodes,
      ),
      minIntervalMs: v.integer(
        'config.health.minIntervalMs',
        healthRaw['minIntervalMs'],
        base.health.minIntervalMs,
        0,
        24 * 60 * MINUTE,
      ),
    },
    retention: {
      keepAllWithinMinutes: v.integer(
        'config.retention.keepAllWithinMinutes',
        retentionRaw['keepAllWithinMinutes'],
        base.retention.keepAllWithinMinutes,
        0,
        365 * DAY,
      ),
      hourlyForHours: v.integer(
        'config.retention.hourlyForHours',
        retentionRaw['hourlyForHours'],
        base.retention.hourlyForHours,
        0,
        24 * 365,
      ),
      dailyForDays: v.integer(
        'config.retention.dailyForDays',
        retentionRaw['dailyForDays'],
        base.retention.dailyForDays,
        0,
        3_650,
      ),
      weeklyForWeeks: v.integer(
        'config.retention.weeklyForWeeks',
        retentionRaw['weeklyForWeeks'],
        base.retention.weeklyForWeeks,
        0,
        520,
      ),
      maxSnapshots: v.integer(
        'config.retention.maxSnapshots',
        retentionRaw['maxSnapshots'],
        base.retention.maxSnapshots,
        1,
        1_000_000,
      ),
    },
    server: {
      host: v.string('config.server.host', serverRaw['host'], base.server.host),
      port: v.integer('config.server.port', serverRaw['port'], base.server.port, 0, 65_535),
    },
    language: v.enum('config.language', root['language'], LANGUAGES, base.language),
  };

  if (config.health.enabled && config.health.command === null) {
    v.fail('config.health.command', 'a command when health.enabled is true', null);
  }
  if (config.health.successExitCodes.length === 0) {
    v.fail('config.health.successExitCodes', 'at least one exit code', []);
  }
  if (config.watch.maxWaitMs < config.watch.quietPeriodMs) {
    v.fail(
      'config.watch.maxWaitMs',
      `a value at least as large as quietPeriodMs (${config.watch.quietPeriodMs})`,
      config.watch.maxWaitMs,
    );
  }
  if (!isLoopbackHost(config.server.host)) {
    v.fail(
      'config.server.host',
      'a loopback address — the UI exposes your source tree, so binding it to a public interface is refused',
      config.server.host,
    );
  }

  v.throwIfInvalid();
  return config;
}

/** Each octet: `0`, or a number with no leading zero. Leading zeros invite octal reads. */
const IPV4_OCTET = /^(?:0|[1-9]\d{0,2})$/;
const IPV4_DOTTED_QUAD = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/**
 * Is this host a loopback address?
 *
 * Load-bearing in two places: it rejects a non-loopback `server.host` at config time,
 * and — more importantly — it validates the incoming `Host` header in the UI server,
 * which is the DNS-rebinding defence for a process that can delete the user's files.
 *
 * That second use is why the IPv4 branch parses a real dotted quad instead of testing
 * for a `127.` prefix. `127.attacker.example.com` is a perfectly registerable domain
 * name; a prefix match accepts it, the attacker points it at 127.0.0.1, and their page
 * is talking to the local server with same-origin standing. The whole control comes
 * apart on one regex.
 *
 * Alternative spellings of 127.0.0.1 — the integer form `2130706433`, the hex form
 * `0x7f000001`, octal octets — are deliberately refused. Node does not produce them in
 * a Host header, and for a security decision an unfamiliar encoding should fail closed.
 */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  if (normalized === 'localhost') return true;
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true;

  const match = IPV4_DOTTED_QUAD.exec(normalized);
  if (match === null) return false;
  for (let index = 1; index <= 4; index += 1) {
    const octet = match[index];
    if (octet === undefined || !IPV4_OCTET.test(octet) || Number(octet) > 255) return false;
  }
  return match[1] === '127';
}

export async function loadConfig(root: string): Promise<TimeloomConfig> {
  const paths = repoPaths(root);
  const raw = await readJsonFile<unknown>(paths.config);
  try {
    return parseConfig(raw);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new TimeloomError('CONFIG_INVALID', `Invalid ${paths.config}`, {
        cause: error,
        hint: `Fix these and try again:\n  - ${error.issues.join('\n  - ')}`,
      });
    }
    throw error;
  }
}

export async function saveConfig(root: string, config: TimeloomConfig): Promise<void> {
  const paths = repoPaths(root);
  await writeJsonFile(paths.config, config, paths.tmp);
}
