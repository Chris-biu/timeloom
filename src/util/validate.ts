/**
 * A tiny structural validator.
 *
 * timeloom ships zero runtime dependencies, so there is no zod here. The trade-off
 * is deliberate: config validation is the only place we need it, the surface is
 * small, and the error messages this produces are better targeted at a beginner
 * than a generic schema library's would be.
 */

export class ValidationError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(issues.join('; '));
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

export class Validator {
  private readonly issues: string[] = [];

  get problems(): readonly string[] {
    return this.issues;
  }

  fail(path: string, expectation: string, actual: unknown): void {
    this.issues.push(`${path}: expected ${expectation}, got ${describe(actual)}`);
  }

  throwIfInvalid(): void {
    if (this.issues.length > 0) throw new ValidationError(this.issues);
  }

  object(path: string, value: unknown): Record<string, unknown> | null {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      this.fail(path, 'an object', value);
      return null;
    }
    return value as Record<string, unknown>;
  }

  string(path: string, value: unknown, fallback: string): string {
    if (value === undefined) return fallback;
    if (typeof value !== 'string') {
      this.fail(path, 'a string', value);
      return fallback;
    }
    return value;
  }

  nullableString(path: string, value: unknown, fallback: string | null): string | null {
    if (value === undefined) return fallback;
    if (value === null) return null;
    if (typeof value !== 'string') {
      this.fail(path, 'a string or null', value);
      return fallback;
    }
    return value;
  }

  boolean(path: string, value: unknown, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    if (typeof value !== 'boolean') {
      this.fail(path, 'true or false', value);
      return fallback;
    }
    return value;
  }

  integer(path: string, value: unknown, fallback: number, min: number, max: number): number {
    if (value === undefined) return fallback;
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      this.fail(path, 'a whole number', value);
      return fallback;
    }
    if (value < min || value > max) {
      this.fail(path, `a whole number between ${min} and ${max}`, value);
      return fallback;
    }
    return value;
  }

  stringArray(path: string, value: unknown, fallback: string[]): string[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) {
      this.fail(path, 'an array of strings', value);
      return fallback;
    }
    const result: string[] = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'string') {
        this.fail(`${path}[${index}]`, 'a string', item);
        continue;
      }
      result.push(item);
    }
    return result;
  }

  integerArray(path: string, value: unknown, fallback: number[]): number[] {
    if (value === undefined) return fallback;
    if (!Array.isArray(value)) {
      this.fail(path, 'an array of whole numbers', value);
      return fallback;
    }
    const result: number[] = [];
    for (const [index, item] of value.entries()) {
      if (typeof item !== 'number' || !Number.isInteger(item)) {
        this.fail(`${path}[${index}]`, 'a whole number', item);
        continue;
      }
      result.push(item);
    }
    return result;
  }

  enum<const T extends readonly string[]>(
    path: string,
    value: unknown,
    allowed: T,
    fallback: T[number],
  ): T[number] {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !allowed.includes(value)) {
      this.fail(path, `one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`, value);
      return fallback;
    }
    return value;
  }

  /** Warn about keys we do not recognise — usually a typo in a hand-edited config. */
  noUnknownKeys(path: string, value: Record<string, unknown>, known: readonly string[]): void {
    for (const key of Object.keys(value)) {
      if (!known.includes(key)) {
        this.issues.push(
          `${path}.${key}: unknown option (did you mean one of: ${known.join(', ')}?)`,
        );
      }
    }
  }
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  // Narrowed inline rather than through a `typeof` stored in a variable, so the
  // compiler actually knows `value` is a primitive before it is stringified.
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'undefined') return 'nothing';
  return typeof value;
}
