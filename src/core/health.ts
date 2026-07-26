import { spawn } from 'node:child_process';

import { describeUnknownError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { HealthResult } from '../types.js';

/** Keep the tail of the probe's output; the reason a build failed is at the end. */
const OUTPUT_TAIL_BYTES = 8 * 1024;

/** How long a terminated process gets to exit before it is killed outright. */
const SIGKILL_GRACE_MS = 3_000;

export interface HealthProbeOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  successExitCodes: readonly number[];
  logger: Logger;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run the project's health command and decide whether this snapshot "works".
 *
 * The distinction that matters to a user is not pass/fail but *why*: a failing build
 * means their code is broken, whereas a probe that could not launch at all means
 * their configuration is broken. Conflating the two would have timeloom quietly
 * report every snapshot as bad after a typo in the command.
 */
export async function runHealthProbe(options: HealthProbeOptions): Promise<HealthResult> {
  const startedAt = Date.now();
  const { command, cwd, timeoutMs, successExitCodes, logger } = options;

  if (options.signal?.aborted === true) {
    return result('skipped', command, null, 0, '');
  }

  const tail = new TailBuffer(OUTPUT_TAIL_BYTES);

  return await new Promise<HealthResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    // Held in one mutable record rather than as two `let` bindings: the timers are
    // created after `finish` closes over them, and a plain `let` assigned exactly once
    // reads to the linter as something that should have been `const`.
    const timers: { timeout?: NodeJS.Timeout; kill?: NodeJS.Timeout } = {};

    const child = spawn(command, {
      cwd,
      shell: true,
      // stdin is closed so a probe that decides to prompt fails fast instead of
      // hanging until the timeout.
      stdio: ['ignore', 'pipe', 'pipe'],
      // A new process group on POSIX makes the whole tree killable. `npm run build`
      // spawns children; signalling only the shell leaves them running forever.
      detached: process.platform !== 'win32',
      env: {
        ...(options.env ?? process.env),
        TIMELOOM_HEALTH_PROBE: '1',
      },
    });

    const finish = (health: HealthResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timers.timeout);
      clearTimeout(timers.kill);
      options.signal?.removeEventListener('abort', onAbort);
      resolve(health);
    };

    function onAbort(): void {
      timedOut = false;
      killTree(child.pid, logger, false);
      finish(result('skipped', command, null, Date.now() - startedAt, tail.toString()));
    }

    options.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk: Buffer) => {
      tail.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      tail.push(chunk);
    });

    child.on('error', (error) => {
      logger.debug('health probe could not start', error);
      finish(
        result(
          'error',
          command,
          null,
          Date.now() - startedAt,
          `${tail.toString()}\n${describeUnknownError(error)}`.trim(),
        ),
      );
    });

    child.on('close', (code, signalName) => {
      const durationMs = Date.now() - startedAt;
      if (timedOut) {
        finish(result('timeout', command, code, durationMs, tail.toString()));
        return;
      }
      if (code === null) {
        // Killed by a signal we did not send — treat as broken, not as a probe fault.
        finish(
          result(
            'broken',
            command,
            null,
            durationMs,
            `${tail.toString()}\n(terminated by ${signalName ?? 'signal'})`.trim(),
          ),
        );
        return;
      }
      const status = successExitCodes.includes(code) ? 'healthy' : 'broken';
      finish(result(status, command, code, durationMs, tail.toString()));
    });

    timers.timeout = setTimeout(() => {
      timedOut = true;
      logger.debug(`health probe exceeded ${timeoutMs}ms; terminating`);
      killTree(child.pid, logger, false);
      timers.kill = setTimeout(() => {
        killTree(child.pid, logger, true);
      }, SIGKILL_GRACE_MS);
      timers.kill.unref();
    }, timeoutMs);
    timers.timeout.unref();
  });
}

function result(
  status: HealthResult['status'],
  command: string,
  exitCode: number | null,
  durationMs: number,
  outputTail: string,
): HealthResult {
  return {
    status,
    command,
    exitCode,
    durationMs,
    checkedAt: new Date().toISOString(),
    outputTail: outputTail.slice(-OUTPUT_TAIL_BYTES),
  };
}

/**
 * Terminate a probe and everything it spawned.
 *
 * Two entirely different mechanisms, because the platforms have nothing in common
 * here: POSIX gets a signal to the negated pid (the process group created by
 * `detached`), Windows gets `taskkill /T` because it has no process groups and a
 * plain `child.kill()` orphans the build tool the shell launched.
 */
function killTree(pid: number | undefined, logger: Logger, force: boolean): void {
  if (pid === undefined) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', (error) => {
        logger.debug('taskkill failed', error);
      });
      killer.unref();
      return;
    }
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch (error) {
    // ESRCH just means it already exited, which is the outcome we wanted.
    logger.debug('could not signal health probe', error);
  }
}

/**
 * A fixed-size window over the end of a stream.
 *
 * A runaway build can emit hundreds of megabytes. Buffering all of it to show the
 * last twenty lines would let a health check exhaust memory.
 */
export class TailBuffer {
  private chunks: Buffer[] = [];
  private length = 0;

  constructor(private readonly limit: number) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.byteLength;
    while (this.length > this.limit && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      if (dropped === undefined) break;
      this.length -= dropped.byteLength;
    }
  }

  toString(): string {
    const combined = Buffer.concat(this.chunks);
    const window = combined.byteLength > this.limit ? combined.subarray(-this.limit) : combined;
    return window.toString('utf8').trimEnd();
  }
}
