import { describeUnknownError } from './errors.js';

export const LOG_LEVELS = ['silent', 'error', 'warn', 'info', 'debug'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

export interface Logger {
  readonly level: LogLevel;
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /**
   * Where diagnostics go. Always stderr by default: stdout is reserved for
   * machine-readable command output so `timeloom list --json | jq` stays clean.
   */
  write?: (line: string) => void;
  /** Emit newline-delimited JSON instead of human text. */
  json?: boolean;
  scope?: string;
}

function defaultWrite(line: string): void {
  process.stderr.write(`${line}\n`);
}

const LABEL: Record<Exclude<LogLevel, 'silent'>, string> = {
  error: 'ERROR',
  warn: ' WARN',
  info: ' INFO',
  debug: 'DEBUG',
};

export function createLogger(options: LoggerOptions): Logger {
  const write = options.write ?? defaultWrite;
  const json = options.json ?? false;
  const scope = options.scope ?? '';
  const level = options.level;
  const threshold = RANK[level];

  function emit(entry: Exclude<LogLevel, 'silent'>, message: string, detail?: unknown): void {
    if (RANK[entry] > threshold) return;
    if (json) {
      write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: entry,
          scope: scope || undefined,
          msg: message,
          detail: detail === undefined ? undefined : normalizeDetail(detail),
        }),
      );
      return;
    }
    const prefix = scope ? `${LABEL[entry]} [${scope}]` : LABEL[entry];
    const suffix = detail === undefined ? '' : ` ${formatDetail(detail)}`;
    write(`${prefix} ${message}${suffix}`);
  }

  return {
    level,
    error: (m, d) => {
      emit('error', m, d);
    },
    warn: (m, d) => {
      emit('warn', m, d);
    },
    info: (m, d) => {
      emit('info', m, d);
    },
    debug: (m, d) => {
      emit('debug', m, d);
    },
    child: (childScope) =>
      createLogger({
        level,
        write,
        json,
        scope: scope ? `${scope}:${childScope}` : childScope,
      }),
  };
}

function normalizeDetail(detail: unknown): unknown {
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message };
  }
  return detail;
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') return `(${detail})`;
  return `(${describeUnknownError(detail)})`;
}

/** A logger that discards everything. Useful in tests and library embedding. */
export const silentLogger: Logger = createLogger({ level: 'silent', write: () => undefined });
