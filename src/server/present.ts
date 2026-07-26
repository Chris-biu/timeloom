import type { Language } from '../config.js';
import { catalog } from '../i18n.js';
import type { HealthResult, SnapshotRecord } from '../types.js';
import { formatBytes } from '../util/fsx.js';
import type { ApiHealth, ApiSnapshot } from './api-types.js';

/**
 * Turn internal records into the shape the UI consumes.
 *
 * All localisation and formatting happens here rather than in the browser. The UI is
 * generated separately and evolves on its own schedule; giving it pre-rendered
 * strings means a change to how timeloom describes a snapshot lands everywhere at
 * once instead of drifting out of sync.
 */
export function toApiSnapshot(
  record: SnapshotRecord,
  language: Language,
  now = Date.now(),
): ApiSnapshot {
  const messages = catalog(language);
  const createdAtMs = Date.parse(record.createdAt);

  return {
    id: record.id,
    seq: record.seq,
    createdAt: record.createdAt,
    createdAtRelative: Number.isNaN(createdAtMs)
      ? messages.unknown
      : messages.relativeTime(now - createdAtMs),
    parentId: record.parentId,
    trigger: record.trigger,
    triggerLabel: messages.triggerLabel[record.trigger],
    label: record.label,
    pinned: record.pinned,
    fileCount: record.fileCount,
    totalBytes: record.totalBytes,
    totalBytesHuman: formatBytes(record.totalBytes),
    summaryText: messages.summary({
      counts: record.summary.counts,
      scope: record.summary.scope,
      kind: record.summary.kind,
    }),
    counts: record.summary.counts,
    samplePaths: record.summary.samplePaths,
    scope: record.summary.scope,
    kind: record.summary.kind,
    health: record.health === null ? null : toApiHealth(record.health, language),
  };
}

export function toApiHealth(health: HealthResult, language: Language): ApiHealth {
  return {
    status: health.status,
    statusLabel: catalog(language).healthLabel[health.status],
    command: health.command,
    exitCode: health.exitCode,
    durationMs: health.durationMs,
    checkedAt: health.checkedAt,
    outputTail: health.outputTail,
  };
}
