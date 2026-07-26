import * as path from 'node:path';

import { defaultConfig, detectLanguage, type Language, type TimeloomConfig } from '../config.js';
import { formatSummary } from '../core/describe.js';
import { diffFileLists, totalChanges } from '../core/diff.js';
import { WatchSession } from '../engine.js';
import { TimeloomError, describeUnknownError } from '../errors.js';
import { catalog } from '../i18n.js';
import type { Logger } from '../logger.js';
import { Repository, detectHealthCommand, type SnapshotOptions } from '../repository.js';
import { startServer } from '../server/http.js';
import type { FileChange, SnapshotRecord, Tree } from '../types.js';
import { formatBytes } from '../util/fsx.js';
import { readVersion } from '../version.js';
import { confirm, out, renderTable, style, type Column } from './ui.js';

export interface CommandContext {
  cwd: string;
  logger: Logger;
  json: boolean;
}

/** Locate the tracked project containing `cwd`, or explain how to create one. */
async function openRepository(context: CommandContext): Promise<Repository> {
  const root = await Repository.find(context.cwd);
  if (root === null) {
    throw new TimeloomError('NOT_INITIALIZED', 'No timeloom project found here or above', {
      hint: 'Run `timeloom init` in your project folder to start tracking it.',
    });
  }
  return Repository.open(root, { logger: context.logger });
}

function describeSnapshot(record: SnapshotRecord, language: Language): string {
  return formatSummary(record.summary, language);
}

function healthCell(record: SnapshotRecord, language: Language): string {
  if (record.health === null) return style.dim('—');
  const label = catalog(language).healthLabel[record.health.status];
  switch (record.health.status) {
    case 'healthy':
      return style.green(label);
    case 'broken':
    case 'timeout':
      return style.red(label);
    case 'error':
      return style.yellow(label);
    case 'skipped':
      return style.dim(label);
  }
}

function relative(record: SnapshotRecord, language: Language, now = Date.now()): string {
  const created = Date.parse(record.createdAt);
  return Number.isNaN(created)
    ? catalog(language).unknown
    : catalog(language).relativeTime(now - created);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

export interface InitArgs {
  language: Language | null;
  health: string | null;
  noHealth: boolean;
  noGitignore: boolean;
}

export async function commandInit(context: CommandContext, args: InitArgs): Promise<number> {
  const root = path.resolve(context.cwd);

  if (await Repository.isInitialized(root)) {
    throw new TimeloomError('ALREADY_INITIALIZED', `${root} is already tracked`, {
      hint: 'Run `timeloom status` to see it, or `timeloom watch` to start snapshotting.',
    });
  }

  const language = args.language ?? detectLanguage();
  const health = args.noHealth ? null : (args.health ?? (await detectHealthCommand(root)));

  const repository = await Repository.init(root, {
    logger: context.logger,
    language,
    updateGitignore: !args.noGitignore,
    healthCommand: health,
  });

  try {
    const latest = repository.latest();
    if (context.json) {
      out(JSON.stringify({ root, snapshot: latest, healthCommand: health, language }, null, 2));
      return 0;
    }

    out(`${style.green('✓')} timeloom is now tracking ${style.bold(root)}`);
    if (latest !== null) {
      out(
        style.dim(
          `  ${latest.fileCount} files, ${formatBytes(latest.totalBytes)} in the first snapshot (${latest.id})`,
        ),
      );
    }
    out(style.dim('  .timeloom/ was added to .gitignore — never commit your snapshot store'));
    if (health !== null) {
      out(style.dim(`  Health check: ${health}`));
    } else {
      out(
        style.dim(
          '  No health check configured. Set one with: timeloom config health.command "npm run build"',
        ),
      );
    }
    out();
    out(`Next: run ${style.cyan('timeloom watch')} and leave it running while you work.`);
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// snap
// ---------------------------------------------------------------------------

export async function commandSnap(
  context: CommandContext,
  args: { label: string | null; force: boolean },
): Promise<number> {
  const repository = await openRepository(context);
  try {
    const options: SnapshotOptions = { trigger: 'manual', label: args.label };
    if (args.force || args.label !== null) options.force = true;
    const outcome = await repository.snapshot(options);

    if (context.json) {
      out(
        JSON.stringify(
          { snapshot: outcome.snapshot, unchanged: outcome.snapshot === null },
          null,
          2,
        ),
      );
      return 0;
    }

    if (outcome.snapshot === null) {
      out(style.dim('Nothing has changed since the last snapshot.'));
      return 0;
    }

    const language = repository.config.language;
    out(
      `${style.green('✓')} ${style.bold(outcome.snapshot.id)}  ${describeSnapshot(outcome.snapshot, language)}`,
    );
    if (outcome.scan.skipped.length > 0) {
      out(
        style.dim(
          `  ${outcome.scan.skipped.length} file(s) skipped — run \`timeloom why <path>\` to see why`,
        ),
      );
    }
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export async function commandList(
  context: CommandContext,
  args: { limit: number; all: boolean },
): Promise<number> {
  const repository = await openRepository(context);
  try {
    const language = repository.config.language;
    const records = repository.list().reverse();
    const shown = args.all ? records : records.slice(0, args.limit);

    if (context.json) {
      out(JSON.stringify({ snapshots: shown, total: records.length }, null, 2));
      return 0;
    }

    if (records.length === 0) {
      out(style.dim('No snapshots yet. Run `timeloom watch` or `timeloom snap`.'));
      return 0;
    }

    const now = Date.now();
    const columns: Column[] = [
      { header: 'ID' },
      { header: 'WHEN' },
      { header: 'WHAT', maxWidth: 52 },
      { header: 'HEALTH' },
      { header: 'TAG', maxWidth: 20 },
    ];
    const rows = shown.map((record) => [
      record.id,
      relative(record, language, now),
      describeSnapshot(record, language),
      healthCell(record, language),
      record.label ?? (record.pinned ? style.dim('pinned') : ''),
    ]);

    out(renderTable(columns, rows));
    if (!args.all && records.length > shown.length) {
      out(style.dim(`\n… and ${records.length - shown.length} more (use --all)`));
    }
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// show
// ---------------------------------------------------------------------------

export async function commandShow(context: CommandContext, reference: string): Promise<number> {
  const repository = await openRepository(context);
  try {
    const language = repository.config.language;
    const record = repository.resolve(reference);
    const parent = record.parentId === null ? null : repository.get(record.parentId);
    const files = await repository.filesOf(record);
    const parentFiles = parent === null ? [] : await repository.filesOf(parent);
    const changes = diffFileLists(parentFiles, files);

    if (context.json) {
      out(JSON.stringify({ snapshot: record, changes }, null, 2));
      return 0;
    }

    out(`${style.bold(record.id)}  ${style.dim(record.createdAt)}  ${relative(record, language)}`);
    out(describeSnapshot(record, language));
    out(
      style.dim(
        `${record.fileCount} files · ${formatBytes(record.totalBytes)} · ${catalog(language).triggerLabel[record.trigger]}${record.label === null ? '' : ` · "${record.label}"`}`,
      ),
    );
    if (record.health !== null) {
      out(`Health: ${healthCell(record, language)} ${style.dim(record.health.command ?? '')}`);
      if (record.health.status !== 'healthy' && record.health.outputTail.length > 0) {
        out(style.dim(indent(record.health.outputTail.split('\n').slice(-8).join('\n'), '  ')));
      }
    }
    out();
    printChanges(changes);
    return 0;
  } finally {
    await repository.close();
  }
}

function indent(text: string, prefix: string): string {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}

function printChanges(changes: readonly FileChange[], limit = 200): void {
  if (changes.length === 0) {
    out(style.dim('No file changes.'));
    return;
  }
  for (const change of changes.slice(0, limit)) {
    const marker =
      change.status === 'added'
        ? style.green('+')
        : change.status === 'deleted'
          ? style.red('-')
          : style.yellow('~');
    out(`${marker} ${change.path}`);
  }
  if (changes.length > limit) {
    out(style.dim(`… and ${changes.length - limit} more`));
  }
}

// ---------------------------------------------------------------------------
// diff
// ---------------------------------------------------------------------------

export async function commandDiff(
  context: CommandContext,
  from: string | null,
  to: string | null,
): Promise<number> {
  const repository = await openRepository(context);
  try {
    // With no arguments, the useful comparison is "the last snapshot versus what is
    // on disk right now" — the question someone actually has.
    const resolvedFrom = from ?? 'latest';
    const diff = await repository.diff(resolvedFrom, to);

    if (context.json) {
      out(JSON.stringify(diff, null, 2));
      return 0;
    }

    const target = to ?? 'your files right now';
    out(style.dim(`${resolvedFrom} → ${target}`));
    out(
      style.dim(
        `${diff.counts.added} added, ${diff.counts.modified} changed, ${diff.counts.deleted} deleted`,
      ),
    );
    out();
    printChanges(diff.changes);
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

export interface RestoreArgs {
  reference: string;
  yes: boolean;
  dryRun: boolean;
  noSafety: boolean;
}

export async function commandRestore(context: CommandContext, args: RestoreArgs): Promise<number> {
  const repository = await openRepository(context);
  try {
    const language = repository.config.language;
    const target = repository.resolve(args.reference);
    const plan = await repository.planRestore(target.id);

    if (plan.write.length === 0 && plan.delete.length === 0) {
      out(style.dim('Your files already match that snapshot. Nothing to do.'));
      return 0;
    }

    if (!context.json) {
      out(
        `Restoring ${style.bold(target.id)} — ${describeSnapshot(target, language)} ${style.dim(`(${relative(target, language)})`)}`,
      );
      out();
      out(
        `This will ${style.yellow(`overwrite ${plan.write.length}`)} file(s) and ${style.red(`delete ${plan.delete.length}`)}.`,
      );
      const preview = [
        ...plan.write.slice(0, 6).map((item) => `  ~ ${item.entry.path}`),
        ...plan.delete.slice(0, 6).map((change) => `  - ${change.path}`),
      ];
      for (const line of preview) out(style.dim(line));
      const hidden = plan.write.length + plan.delete.length - preview.length;
      if (hidden > 0) out(style.dim(`  … and ${hidden} more`));
      if (plan.untouched.length > 0) {
        out(style.dim(`  ${plan.untouched.length} untracked file(s) will be left alone`));
      }
      out();
      if (!args.noSafety && !args.dryRun) {
        out(style.dim('A snapshot of your current files is saved first, so this is undoable.'));
      }
      if (args.noSafety) {
        out(style.red('--no-safety: your current files will NOT be saved first.'));
      }
    }

    if (!args.dryRun && !args.yes) {
      const answer = await confirm('Continue?', false);
      if (answer === null) {
        throw new TimeloomError('IO', 'Cannot ask for confirmation without a terminal', {
          hint: 'Re-run with --yes if you are sure.',
        });
      }
      if (!answer) {
        out(style.dim('Cancelled. Nothing was changed.'));
        return 0;
      }
    }

    const result = await repository.restore(target.id, {
      dryRun: args.dryRun,
      safetySnapshot: !args.noSafety,
    });

    if (context.json) {
      out(JSON.stringify(result, null, 2));
      return 0;
    }

    if (args.dryRun) {
      out(
        style.dim(`Dry run: would write ${result.written} and delete ${result.deleted} file(s).`),
      );
      return 0;
    }

    out(`${style.green('✓')} Restored ${result.written} file(s), removed ${result.deleted}.`);
    if (result.safetySnapshotId !== null) {
      out(
        style.dim(
          `  Your previous files are saved as ${result.safetySnapshotId} — undo this with: timeloom restore ${result.safetySnapshotId}`,
        ),
      );
    }
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

export async function commandCheck(context: CommandContext, reference: string): Promise<number> {
  const repository = await openRepository(context);
  try {
    if (!repository.config.health.enabled || repository.config.health.command === null) {
      throw new TimeloomError('PROBE_CONFIG', 'No health check is configured', {
        hint: 'Set one with: timeloom config health.command "npm run build"',
      });
    }

    const record = repository.resolve(reference);
    if (!context.json) {
      out(style.dim(`Running: ${repository.config.health.command}`));
    }
    const result = await repository.checkHealth(record);

    if (context.json) {
      out(JSON.stringify({ snapshotId: record.id, health: result }, null, 2));
      return result.status === 'healthy' ? 0 : 1;
    }

    const language = repository.config.language;
    const label = catalog(language).healthLabel[result.status];
    if (result.status === 'healthy') {
      out(`${style.green('✓')} ${record.id}: ${style.green(label)} (${result.durationMs}ms)`);
      return 0;
    }

    out(`${style.red('✗')} ${record.id}: ${style.red(label)} (exit ${result.exitCode ?? '—'})`);
    if (result.outputTail.length > 0) {
      out(style.dim(indent(result.outputTail.split('\n').slice(-15).join('\n'), '  ')));
    }
    return 1;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export async function commandStatus(context: CommandContext): Promise<number> {
  const repository = await openRepository(context);
  try {
    const language = repository.config.language;
    const status = await repository.status();

    if (context.json) {
      out(JSON.stringify(status, null, 2));
      return 0;
    }

    const rows: [string, string][] = [];
    rows.push(['project', `${path.basename(status.root)}  ${style.dim(status.root)}`]);
    rows.push(['snapshots', String(status.snapshotCount)]);

    if (status.latest !== null) {
      rows.push([
        'latest',
        `${status.latest.id}  ${relative(status.latest, language)}  ${describeSnapshot(status.latest, language)}`,
      ]);
    }
    if (status.lastHealthy !== null) {
      rows.push([
        'last working',
        `${status.lastHealthy.id}  ${relative(status.lastHealthy, language)}`,
      ]);
    } else if (repository.config.health.enabled) {
      rows.push(['last working', style.dim('none yet')]);
    }
    if (status.pendingChanges !== null) {
      const pending = totalChanges(status.pendingChanges);
      rows.push([
        'unsaved',
        pending === 0
          ? style.dim('nothing changed since the last snapshot')
          : style.yellow(
              `${status.pendingChanges.added} added, ${status.pendingChanges.modified} changed, ${status.pendingChanges.deleted} deleted`,
            ),
      ]);
    }
    rows.push(['store', `${formatBytes(status.storeBytes)} across ${status.objectCount} objects`]);
    rows.push([
      'watching',
      status.daemon === null
        ? style.dim('no — run `timeloom watch`')
        : style.green(`yes (pid ${status.daemon.pid})`),
    ]);

    const labelWidth = Math.max(...rows.map(([label]) => label.length));
    for (const [label, value] of rows) {
      out(`${style.dim(label.padEnd(labelWidth))}  ${value}`);
    }
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

export async function commandWatch(
  context: CommandContext,
  args: { ui: boolean; port: number | null; open: boolean },
): Promise<number> {
  const repository = await openRepository(context);
  const version = await readVersion();
  let server: Awaited<ReturnType<typeof startServer>> | null = null;

  const session = new WatchSession({
    repository,
    logger: context.logger,
    onEvent: (event) => server?.broadcast(event),
    ...(args.port !== null ? { port: args.port } : {}),
  });

  if (args.ui) {
    server = await startServer({
      repository,
      session,
      logger: context.logger,
      host: repository.config.server.host,
      port: args.port ?? repository.config.server.port,
      version,
    });
  }

  await session.start();

  out(`${style.green('●')} Watching ${style.bold(repository.root)}`);
  if (server !== null) {
    out(`  UI: ${style.cyan(server.url)}`);
  }
  out(style.dim('  Press Ctrl+C to stop.'));

  await new Promise<void>((resolve) => {
    let shuttingDown = false;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      out();
      out(style.dim('Stopping…'));
      void (async () => {
        await session.stop();
        await server?.close();
        await repository.close();
        resolve();
      })();
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

  return 0;
}

// ---------------------------------------------------------------------------
// prune / label / pin
// ---------------------------------------------------------------------------

export async function commandPrune(
  context: CommandContext,
  args: { dryRun: boolean },
): Promise<number> {
  const repository = await openRepository(context);
  try {
    if (args.dryRun) {
      const plan = repository.planPrune();
      if (context.json) {
        out(JSON.stringify(plan, null, 2));
        return 0;
      }
      out(
        `Would remove ${style.bold(String(plan.drop.length))} of ${plan.keep.length + plan.drop.length} snapshots.`,
      );
      for (const id of plan.drop.slice(0, 15)) {
        out(style.dim(`  ${id}  ${plan.reasons[id] ?? ''}`));
      }
      if (plan.drop.length > 15) out(style.dim(`  … and ${plan.drop.length - 15} more`));
      return 0;
    }

    const result = await repository.prune();
    if (context.json) {
      out(JSON.stringify(result, null, 2));
      return 0;
    }
    out(
      `${style.green('✓')} Removed ${result.droppedSnapshots} snapshot(s) and ${result.deletedObjects} object(s), freeing ${formatBytes(result.reclaimedBytes)}.`,
    );
    return 0;
  } finally {
    await repository.close();
  }
}

export async function commandLabel(
  context: CommandContext,
  reference: string,
  label: string | null,
): Promise<number> {
  const repository = await openRepository(context);
  try {
    const record = repository.resolve(reference);
    const updated = await repository.update(record.id, { label });
    if (context.json) {
      out(JSON.stringify(updated, null, 2));
      return 0;
    }
    out(
      label === null
        ? `${style.green('✓')} Removed the name from ${updated.id}.`
        : `${style.green('✓')} ${updated.id} is now called "${label}". Named snapshots are never auto-deleted.`,
    );
    return 0;
  } finally {
    await repository.close();
  }
}

export async function commandPin(
  context: CommandContext,
  reference: string,
  pinned: boolean,
): Promise<number> {
  const repository = await openRepository(context);
  try {
    const record = repository.resolve(reference);
    const updated = await repository.update(record.id, { pinned });
    if (context.json) {
      out(JSON.stringify(updated, null, 2));
      return 0;
    }
    out(
      pinned
        ? `${style.green('✓')} ${updated.id} is pinned and will never be auto-deleted.`
        : `${style.green('✓')} ${updated.id} is no longer pinned.`,
    );
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// why
// ---------------------------------------------------------------------------

export async function commandWhy(context: CommandContext, target: string): Promise<number> {
  const repository = await openRepository(context);
  try {
    // A scan folds every nested .gitignore into the matcher; without it we would
    // only be able to explain the built-in rules.
    await repository.scanWorkingTree();

    const absolute = path.resolve(context.cwd, target);
    const relativePath = path.relative(repository.root, absolute).split(path.sep).join('/');
    if (relativePath.startsWith('..')) {
      throw new TimeloomError('PATH_ESCAPE', `${target} is outside ${repository.root}`);
    }

    const decision = repository.ignoreMatcher.decide(relativePath, false);
    if (context.json) {
      out(
        JSON.stringify(
          {
            path: relativePath,
            tracked: !decision.ignored,
            rule:
              decision.rule === null
                ? null
                : { pattern: decision.rule.pattern, source: decision.rule.source },
            viaAncestor: decision.viaAncestor,
          },
          null,
          2,
        ),
      );
      return 0;
    }

    if (!decision.ignored) {
      out(`${style.green('✓')} ${relativePath} is tracked.`);
      if (decision.rule !== null) {
        out(style.dim(`  Re-included by "${decision.rule.pattern}" (${decision.rule.source})`));
      }
      return 0;
    }

    out(`${style.yellow('✗')} ${relativePath} is not tracked.`);
    if (decision.viaAncestor !== null) {
      out(style.dim(`  Because the folder ${decision.viaAncestor} is excluded.`));
    }
    if (decision.rule !== null) {
      out(style.dim(`  Rule: "${decision.rule.pattern}" from ${decision.rule.source}`));
      out(
        style.dim(
          '  To track it anyway, add an exception to config.ignore, e.g. `timeloom config ignore.add "!path/to/file"`',
        ),
      );
    }
    return 0;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

export async function commandDoctor(
  context: CommandContext,
  args: { deep: boolean },
): Promise<number> {
  const repository = await openRepository(context);
  try {
    const problems: string[] = [];
    let checkedTrees = 0;
    let checkedBlobs = 0;

    for (const record of repository.list()) {
      let tree: Tree;
      try {
        tree = await repository.objectStore.getJson<Tree>(record.treeHash);
        checkedTrees += 1;
      } catch (error) {
        problems.push(
          `snapshot ${record.id}: file list unreadable (${describeUnknownError(error)})`,
        );
        continue;
      }
      for (const file of tree.files) {
        if (args.deep) {
          try {
            await repository.objectStore.get(file.hash);
            checkedBlobs += 1;
          } catch (error) {
            problems.push(`snapshot ${record.id}: ${file.path} — ${describeUnknownError(error)}`);
          }
        } else if (!(await repository.objectStore.has(file.hash))) {
          problems.push(`snapshot ${record.id}: ${file.path} — stored content is missing`);
        } else {
          checkedBlobs += 1;
        }
      }
    }

    if (context.json) {
      out(JSON.stringify({ problems, checkedTrees, checkedBlobs }, null, 2));
      return problems.length === 0 ? 0 : 1;
    }

    out(
      style.dim(
        `Checked ${checkedTrees} snapshot file list(s) and ${checkedBlobs} stored file(s)${args.deep ? ' with full hash verification' : ''}.`,
      ),
    );
    if (problems.length === 0) {
      out(`${style.green('✓')} The snapshot store looks healthy.`);
      return 0;
    }
    out(style.red(`${problems.length} problem(s) found:`));
    for (const problem of problems.slice(0, 50)) out(`  ${problem}`);
    if (problems.length > 50) out(style.dim(`  … and ${problems.length - 50} more`));
    out();
    out(
      style.dim(
        'Snapshots referencing missing content cannot be fully restored. Newer snapshots are unaffected.',
      ),
    );
    return 1;
  } finally {
    await repository.close();
  }
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

const CONFIG_SETTERS: Record<string, (config: TimeloomConfig, value: string) => void> = {
  'health.command': (config, value) => {
    config.health = { ...config.health, command: value, enabled: value.length > 0 };
  },
  'health.enabled': (config, value) => {
    config.health = { ...config.health, enabled: value === 'true' };
  },
  'health.timeoutMs': (config, value) => {
    config.health = { ...config.health, timeoutMs: parseIntOrThrow('health.timeoutMs', value) };
  },
  'watch.quietPeriodMs': (config, value) => {
    config.watch = {
      ...config.watch,
      quietPeriodMs: parseIntOrThrow('watch.quietPeriodMs', value),
    };
  },
  maxFileBytes: (config, value) => {
    config.maxFileBytes = parseIntOrThrow('maxFileBytes', value);
  },
  language: (config, value) => {
    if (value !== 'en' && value !== 'zh-CN') {
      throw new TimeloomError('CONFIG_INVALID', 'language must be "en" or "zh-CN"');
    }
    config.language = value;
  },
  'server.port': (config, value) => {
    config.server = { ...config.server, port: parseIntOrThrow('server.port', value) };
  },
  'retention.maxSnapshots': (config, value) => {
    config.retention = {
      ...config.retention,
      maxSnapshots: parseIntOrThrow('retention.maxSnapshots', value),
    };
  },
  'ignore.add': (config, value) => {
    if (!config.ignore.includes(value)) config.ignore = [...config.ignore, value];
  },
  'ignore.remove': (config, value) => {
    config.ignore = config.ignore.filter((pattern) => pattern !== value);
  },
};

function parseIntOrThrow(key: string, value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new TimeloomError('CONFIG_INVALID', `${key} must be a number, got "${value}"`);
  }
  return parsed;
}

export async function commandConfig(
  context: CommandContext,
  key: string | null,
  value: string | null,
): Promise<number> {
  const repository = await openRepository(context);
  try {
    if (key === null) {
      out(JSON.stringify(repository.config, null, 2));
      return 0;
    }

    if (value === null) {
      const current = readConfigKey(repository.config, key);
      out(typeof current === 'string' ? current : JSON.stringify(current, null, 2));
      return 0;
    }

    const setter = CONFIG_SETTERS[key];
    if (setter === undefined) {
      throw new TimeloomError('CONFIG_INVALID', `Unknown setting "${key}"`, {
        hint: `Settable keys: ${Object.keys(CONFIG_SETTERS).join(', ')}. Everything else can be edited in .timeloom/config.json.`,
      });
    }

    const next: TimeloomConfig = structuredClone(repository.config);
    setter(next, value);
    await repository.setConfig(next);
    out(`${style.green('✓')} ${key} = ${value}`);
    return 0;
  } finally {
    await repository.close();
  }
}

function readConfigKey(config: TimeloomConfig, key: string): unknown {
  let current: unknown = config;
  for (const segment of key.split('.')) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

export function exampleConfig(): TimeloomConfig {
  return defaultConfig();
}
