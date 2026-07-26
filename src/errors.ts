/**
 * Every failure timeloom raises deliberately carries a machine-readable code and,
 * where possible, a hint written for someone who has never used a version control
 * system. The CLI renders `hint` directly to the user.
 */
export type TimeloomErrorCode =
  | 'NOT_INITIALIZED'
  | 'ALREADY_INITIALIZED'
  | 'SNAPSHOT_NOT_FOUND'
  | 'AMBIGUOUS_ID'
  | 'OBJECT_MISSING'
  | 'CORRUPT_OBJECT'
  | 'CONFIG_INVALID'
  | 'LOCK_HELD'
  | 'PATH_ESCAPE'
  | 'UNSAFE_ROOT'
  | 'PROBE_CONFIG'
  | 'IO';

export interface TimeloomErrorOptions {
  /** Actionable next step, in plain language. Rendered verbatim by the CLI. */
  hint?: string;
  cause?: unknown;
}

export class TimeloomError extends Error {
  readonly code: TimeloomErrorCode;
  readonly hint: string | null;

  constructor(code: TimeloomErrorCode, message: string, options: TimeloomErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'TimeloomError';
    this.code = code;
    this.hint = options.hint ?? null;
  }
}

export function isTimeloomError(value: unknown): value is TimeloomError {
  return value instanceof TimeloomError;
}

/** Node's fs errors carry `code` but are typed as `Error`. This narrows safely. */
export function errnoCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const code: unknown = (value as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

export function isErrno(value: unknown, ...codes: readonly string[]): boolean {
  const code = errnoCode(value);
  return code !== null && codes.includes(code);
}

/**
 * `JSON.stringify` is declared as returning `string`, but it genuinely returns
 * `undefined` for `undefined`, functions and symbols. Re-typing the reference once is
 * the only way to state that without an assertion at every call site — and without it
 * the compiler insists the `undefined` branch below is unreachable, which is exactly
 * the branch that fires when someone throws a bare `undefined`.
 */
const stringifyOrUndefined = JSON.stringify as (value: unknown) => string | undefined;

export function describeUnknownError(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;

  try {
    const json = stringifyOrUndefined(value);
    if (json !== undefined) return json;
  } catch {
    // Circular structures and BigInt both throw. Fall through to the type tag.
  }

  // Not `String(value)`: an object without a custom toString gives "[object Object]"
  // either way, and this spelling says so on purpose instead of by accident.
  return Object.prototype.toString.call(value);
}
