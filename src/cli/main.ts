#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from 'node:util';

import type { Language } from '../config.js';
import { describeUnknownError, isTimeloomError } from '../errors.js';
import { createLogger, isLogLevel, type LogLevel } from '../logger.js';
import { ValidationError } from '../util/validate.js';
import { readVersion } from '../version.js';
import {
  commandCheck,
  commandConfig,
  commandDiff,
  commandDoctor,
  commandInit,
  commandLabel,
  commandList,
  commandPin,
  commandPrune,
  commandRestore,
  commandShow,
  commandSnap,
  commandStatus,
  commandWatch,
  commandWhy,
  type CommandContext,
} from './commands.js';
import { err, out, style } from './ui.js';

type OptionConfig = NonNullable<ParseArgsConfig['options']>;

const GLOBAL_OPTIONS = {
  cwd: { type: 'string', short: 'C' },
  'log-level': { type: 'string' },
  json: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} satisfies OptionConfig;

const COMMAND_OPTIONS: Record<string, OptionConfig> = {
  init: {
    language: { type: 'string' },
    health: { type: 'string' },
    'no-health': { type: 'boolean', default: false },
    'no-gitignore': { type: 'boolean', default: false },
  },
  snap: {
    label: { type: 'string', short: 'm' },
    force: { type: 'boolean', default: false },
  },
  list: {
    limit: { type: 'string', short: 'n' },
    all: { type: 'boolean', default: false },
  },
  watch: {
    ui: { type: 'boolean', default: false },
    port: { type: 'string' },
    open: { type: 'boolean', default: false },
  },
  restore: {
    yes: { type: 'boolean', short: 'y', default: false },
    'dry-run': { type: 'boolean', default: false },
    'no-safety': { type: 'boolean', default: false },
  },
  prune: {
    'dry-run': { type: 'boolean', default: false },
  },
  doctor: {
    deep: { type: 'boolean', default: false },
  },
};

const HELP = `${style.bold('timeloom')} — automatic snapshots of your project, so you can always go back.

${style.bold('Usage')}
  timeloom <command> [options]

${style.bold('Getting started')}
  init                  Start tracking this folder
  watch [--ui]          Watch for changes and snapshot automatically (leave running)
  restore healthy       Go back to the last version that actually worked

${style.bold('Looking around')}
  status                What is going on with this project
  list [-n 20] [--all]  Recent snapshots
  show <ref>            What a snapshot contains
  diff [from] [to]      Compare snapshots, or a snapshot against your current files
  check [ref]           Run the health command and record the verdict
  why <path>            Explain whether a file is being tracked

${style.bold('Saving and restoring')}
  snap [-m "name"]      Take a snapshot right now
  restore <ref>         Put your files back to a snapshot
  label <ref> <name>    Name a snapshot (named ones are never auto-deleted)
  unlabel <ref>         Remove the name
  pin <ref> / unpin     Keep a snapshot forever

${style.bold('Housekeeping')}
  prune [--dry-run]     Thin out old snapshots
  doctor [--deep]       Check the snapshot store for problems
  config [key] [value]  Read or change settings

${style.bold('Snapshot references')}
  Anything that identifies a snapshot works:
    ${style.cyan('a1b2c3d4')}   a full id, or the first few characters of one
    ${style.cyan('latest')}     the newest snapshot
    ${style.cyan('healthy')}    the newest one that passed the health check
    ${style.cyan('~3')}         three snapshots back
    ${style.cyan('"my name"')}  a snapshot you labelled

${style.bold('Global options')}
  -C, --cwd <dir>       Work in a different folder
      --json            Machine-readable output
      --log-level <l>   silent | error | warn | info | debug
  -h, --help            Show this
  -v, --version         Show the version
`;

export async function run(argv: readonly string[]): Promise<number> {
  const commandName = argv.find((argument) => !argument.startsWith('-')) ?? '';
  const options: OptionConfig = { ...GLOBAL_OPTIONS, ...(COMMAND_OPTIONS[commandName] ?? {}) };

  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
  } catch (error) {
    err(style.red(describeUnknownError(error)));
    err(style.dim('Run `timeloom --help` to see the available options.'));
    return 2;
  }

  const values = parsed.values;
  const positionals = parsed.positionals;

  if (values['version'] === true) {
    out(await readVersion());
    return 0;
  }
  const [command, ...rest] = positionals;

  if (values['help'] === true || command === undefined) {
    out(HELP);
    // No command at all is a usage error, even though we print the same help text.
    return command === undefined && values['help'] !== true ? 2 : 0;
  }

  const level = resolveLogLevel(values['log-level']);
  const context: CommandContext = {
    cwd: typeof values['cwd'] === 'string' ? values['cwd'] : process.cwd(),
    logger: createLogger({ level }),
    json: values['json'] === true,
  };

  switch (command) {
    case 'init':
      return commandInit(context, {
        language: parseLanguage(values['language']),
        health: stringOrNull(values['health']),
        noHealth: values['no-health'] === true,
        noGitignore: values['no-gitignore'] === true,
      });

    case 'snap':
    case 'save':
      return commandSnap(context, {
        label: stringOrNull(values['label']),
        force: values['force'] === true,
      });

    case 'list':
    case 'ls':
      return commandList(context, {
        limit: parsePositiveInt(values['limit'], 20),
        all: values['all'] === true,
      });

    case 'show':
      return commandShow(context, requireArgument(rest[0], 'show <ref>'));

    case 'diff':
      return commandDiff(context, rest[0] ?? null, rest[1] ?? null);

    case 'restore':
    case 'undo':
      return commandRestore(context, {
        reference: rest[0] ?? 'healthy',
        yes: values['yes'] === true,
        dryRun: values['dry-run'] === true,
        noSafety: values['no-safety'] === true,
      });

    case 'status':
      return commandStatus(context);

    case 'check':
      return commandCheck(context, rest[0] ?? 'latest');

    case 'watch':
      return commandWatch(context, {
        ui: values['ui'] === true,
        port: values['port'] === undefined ? null : parsePositiveInt(values['port'], 0),
        open: values['open'] === true,
      });

    case 'prune':
      return commandPrune(context, { dryRun: values['dry-run'] === true });

    case 'doctor':
      return commandDoctor(context, { deep: values['deep'] === true });

    case 'label':
      return commandLabel(
        context,
        requireArgument(rest[0], 'label <ref> <name>'),
        requireArgument(rest[1], 'label <ref> <name>'),
      );

    case 'unlabel':
      return commandLabel(context, requireArgument(rest[0], 'unlabel <ref>'), null);

    case 'pin':
      return commandPin(context, requireArgument(rest[0], 'pin <ref>'), true);

    case 'unpin':
      return commandPin(context, requireArgument(rest[0], 'unpin <ref>'), false);

    case 'why':
      return commandWhy(context, requireArgument(rest[0], 'why <path>'));

    case 'config':
      return commandConfig(context, rest[0] ?? null, rest[1] ?? null);

    default:
      err(style.red(`Unknown command "${command}"`));
      err(style.dim('Run `timeloom --help` to see what is available.'));
      return 2;
  }
}

function requireArgument(value: string | undefined, usage: string): string {
  if (value === undefined || value.length === 0) {
    throw new UsageError(`Missing argument. Usage: timeloom ${usage}`);
  }
  return value;
}

class UsageError extends Error {}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseLanguage(value: unknown): Language | null {
  if (value === 'en' || value === 'zh-CN') return value;
  return null;
}

function parsePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'string') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) || parsed < 0 ? fallback : parsed;
}

function resolveLogLevel(value: unknown): LogLevel {
  if (typeof value === 'string' && isLogLevel(value)) return value;
  return 'warn';
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      err(style.red(error.message));
      process.exitCode = 2;
      return;
    }
    if (isTimeloomError(error)) {
      err(`${style.red('✗')} ${error.message}`);
      if (error.hint !== null) err(style.dim(`  ${error.hint}`));
      process.exitCode = 1;
      return;
    }
    if (error instanceof ValidationError) {
      err(`${style.red('✗')} Invalid configuration:`);
      for (const issue of error.issues) err(style.dim(`  - ${issue}`));
      process.exitCode = 1;
      return;
    }
    err(`${style.red('✗')} ${describeUnknownError(error)}`);
    if (process.env['TIMELOOM_DEBUG'] === '1' && error instanceof Error) {
      err(style.dim(error.stack ?? ''));
    } else {
      err(style.dim('  Set TIMELOOM_DEBUG=1 for a stack trace.'));
    }
    process.exitCode = 1;
  }
}

// Writing to a closed pipe (`timeloom list | head`) is normal, not a crash.
process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
});

await main();
