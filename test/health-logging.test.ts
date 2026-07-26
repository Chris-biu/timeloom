import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runHealthProbe, TailBuffer } from '../src/core/health.js';
import { createLogger, isLogLevel, LOG_LEVELS, silentLogger } from '../src/logger.js';
import { readVersion } from '../src/version.js';

let tempRoot: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-health-'));
});

afterEach(async () => {
  await removeWithRetry(tempRoot);
});

/**
 * Windows holds a directory handle until every process with it as its working
 * directory has actually exited. `runHealthProbe` signals a terminated child and
 * resolves without waiting for the kill to land — deliberately, since a caller
 * should not block on a build it has already given up on — so cleanup can arrive
 * first and see EBUSY. That is a race in the test harness, not in the product.
 */
async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/**
 * Commands are spelled without inner single quotes so the same string works in both
 * `cmd.exe` and `sh`. `spawn(..., { shell: true })` picks a different one per platform
 * and cmd does not treat `'` as a quote at all.
 */
function probe(command: string, overrides: Partial<Parameters<typeof runHealthProbe>[0]> = {}) {
  return runHealthProbe({
    command,
    cwd: tempRoot,
    timeoutMs: 20_000,
    successExitCodes: [0],
    logger: silentLogger,
    ...overrides,
  });
}

describe('runHealthProbe', () => {
  it('reports healthy when the command exits zero', async () => {
    const result = await probe('node -e "process.exit(0)"');

    expect(result.status).toBe('healthy');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('reports broken when the command exits non-zero', async () => {
    const result = await probe('node -e "process.exit(1)"');

    expect(result.status).toBe('broken');
    expect(result.exitCode).toBe(1);
  });

  it('honours a custom set of success exit codes', async () => {
    const accepted = await probe('node -e "process.exit(3)"', { successExitCodes: [0, 3] });
    const rejected = await probe('node -e "process.exit(3)"', { successExitCodes: [0] });

    expect(accepted.status).toBe('healthy');
    expect(rejected.status).toBe('broken');
  });

  it('captures the command output so a broken build can be explained', async () => {
    const result = await probe('node -e "console.log(9876543); process.exit(1)"');

    expect(result.status).toBe('broken');
    expect(result.outputTail).toContain('9876543');
  });

  it('captures stderr as well as stdout, because build errors go there', async () => {
    const result = await probe('node -e "console.error(5551212); process.exit(1)"');

    expect(result.outputTail).toContain('5551212');
  });

  it('records the command it ran, so a report can show what was checked', async () => {
    const result = await probe('node -e "process.exit(0)"');

    expect(result.command).toBe('node -e "process.exit(0)"');
  });

  it('reports timeout, not broken, when the command outruns its budget', async () => {
    // The distinction matters: a slow build is a different problem from a broken one,
    // and telling a user their code is broken when it merely took too long is wrong.
    const result = await probe('node -e "setTimeout(function(){}, 60000)"', { timeoutMs: 600 });

    expect(result.status).toBe('timeout');
  }, 30_000);

  it('actually terminates the process it timed out on', async () => {
    // A probe that reports a timeout while leaving the build running would leak one
    // process per snapshot for as long as the watcher runs.
    const marker = path.join(tempRoot, 'still-alive.txt');
    const script = path.join(tempRoot, 'linger.js');
    await fs.writeFile(
      script,
      `setTimeout(function () { require("fs").writeFileSync(${JSON.stringify(marker)}, "x"); }, 3000);\n`,
      'utf8',
    );

    const result = await probe(`node ${JSON.stringify(script)}`, { timeoutMs: 500 });
    expect(result.status).toBe('timeout');

    await new Promise((resolve) => setTimeout(resolve, 4000));
    await expect(fs.stat(marker)).rejects.toThrow();
  }, 30_000);

  it('reports skipped when the caller aborts', async () => {
    const controller = new AbortController();
    const pending = probe('node -e "setTimeout(function(){}, 30000)"', {
      signal: controller.signal,
    });
    controller.abort();

    const result = await pending;
    expect(result.status).toBe('skipped');
  }, 30_000);

  it('reports skipped immediately when the signal is already aborted', async () => {
    const result = await probe('node -e "process.exit(0)"', { signal: AbortSignal.abort() });

    expect(result.status).toBe('skipped');
    expect(result.durationMs).toBe(0);
  });

  it('passes TIMELOOM_HEALTH_PROBE so a script can tell who is calling', async () => {
    const result = await probe(
      'node -e "process.exit(process.env.TIMELOOM_HEALTH_PROBE === String(1) ? 0 : 1)"',
    );

    expect(result.status).toBe('healthy');
  });

  it('runs in the directory it was given', async () => {
    const witness = path.join(tempRoot, 'witness.txt');
    await fs.writeFile(witness, 'here', 'utf8');

    const result = await probe(
      'node -e "process.exit(require(String.fromCharCode(102,115)).existsSync(String.fromCharCode(119,105,116,110,101,115,115,46,116,120,116)) ? 0 : 1)"',
    );

    expect(result.status).toBe('healthy');
  });
});

describe('TailBuffer', () => {
  it('returns everything when the output fits', () => {
    const tail = new TailBuffer(1024);
    tail.push(Buffer.from('hello ', 'utf8'));
    tail.push(Buffer.from('world', 'utf8'));

    expect(tail.toString()).toBe('hello world');
  });

  it('keeps the end rather than the beginning, because that is where the error is', () => {
    const tail = new TailBuffer(16);
    for (let index = 0; index < 40; index += 1) {
      tail.push(Buffer.from(`${index}\n`, 'utf8'));
    }

    const output = tail.toString();
    expect(output.length).toBeLessThanOrEqual(16);
    expect(output).toContain('39');
    expect(output).not.toContain('0\n1\n2');
  });

  it('never grows without bound however much is pushed', () => {
    // A runaway build can emit hundreds of megabytes; buffering all of it to show the
    // last twenty lines is how a health check exhausts memory.
    const tail = new TailBuffer(64);
    const chunk = Buffer.alloc(4096, 0x61);
    for (let index = 0; index < 500; index += 1) tail.push(chunk);

    expect(Buffer.byteLength(tail.toString(), 'utf8')).toBeLessThanOrEqual(64);
  });

  it('is empty before anything is pushed', () => {
    expect(new TailBuffer(32).toString()).toBe('');
  });

  it('trims trailing whitespace so a report does not end in blank lines', () => {
    const tail = new TailBuffer(64);
    tail.push(Buffer.from('done\n\n\n', 'utf8'));

    expect(tail.toString()).toBe('done');
  });
});

describe('logger', () => {
  function capture(level: Parameters<typeof createLogger>[0]['level'], json = false) {
    const lines: string[] = [];
    const logger = createLogger({ level, json, write: (line) => lines.push(line) });
    return { logger, lines };
  }

  it('emits nothing at all at the silent level', () => {
    const { logger, lines } = capture('silent');
    logger.error('boom');
    logger.warn('careful');
    logger.info('fyi');
    logger.debug('detail');

    expect(lines).toEqual([]);
  });

  it('emits only at or above the configured level', () => {
    const { logger, lines } = capture('warn');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('e');
    expect(lines[1]).toContain('w');
  });

  it('emits everything at debug', () => {
    const { logger, lines } = capture('debug');
    logger.error('e');
    logger.warn('w');
    logger.info('i');
    logger.debug('d');

    expect(lines).toHaveLength(4);
  });

  it('prefixes a child logger with its scope', () => {
    const { logger, lines } = capture('debug');
    logger.child('watch').child('scan').info('hello');

    expect(lines[0]).toContain('[watch:scan]');
  });

  it('renders one JSON object per line in json mode', () => {
    const { logger, lines } = capture('info', true);
    logger.info('taking a snapshot', { id: 'a1b2' });

    const parsed = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    expect(parsed['level']).toBe('info');
    expect(parsed['msg']).toBe('taking a snapshot');
    expect(parsed['detail']).toEqual({ id: 'a1b2' });
  });

  it('reduces an Error detail to its name and message rather than a stack dump', () => {
    const { logger, lines } = capture('info', true);
    logger.info('failed', new TypeError('nope'));

    const parsed = JSON.parse(lines[0] ?? '{}') as { detail?: Record<string, unknown> };
    expect(parsed.detail).toEqual({ name: 'TypeError', message: 'nope' });
  });

  it('formats a string detail in parentheses', () => {
    const { logger, lines } = capture('debug');
    logger.debug('skipped', 'node_modules');

    expect(lines[0]).toContain('(node_modules)');
  });

  it('survives a circular detail instead of throwing out of the log call', () => {
    // Logging must never be the thing that crashes an operation.
    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;
    const { logger, lines } = capture('debug');

    expect(() => {
      logger.debug('cycle', circular);
    }).not.toThrow();
    expect(lines).toHaveLength(1);
  });

  it('recognises exactly the documented level names', () => {
    for (const level of LOG_LEVELS) expect(isLogLevel(level)).toBe(true);
    expect(isLogLevel('verbose')).toBe(false);
    expect(isLogLevel('')).toBe(false);
  });

  it('exposes a silent logger that accepts every call', () => {
    expect(() => {
      silentLogger.error('a');
      silentLogger.child('x').debug('b', { c: 1 });
    }).not.toThrow();
  });
});

describe('readVersion', () => {
  it('reads the version out of package.json', async () => {
    await expect(readVersion()).resolves.toMatch(/^\d+\.\d+\.\d+/);
  });

  it('is cached, so repeated calls agree', async () => {
    expect(await readVersion()).toBe(await readVersion());
  });
});
