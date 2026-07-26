import type { RetentionConfig } from '../config.js';
import type { Logger } from '../logger.js';
import type { PrunePlan, PruneResult, SnapshotRecord, Tree } from '../types.js';
import type { ObjectStore } from './cas.js';
import type { SnapshotIndex } from './store.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

export interface PlanPruneInput {
  records: readonly SnapshotRecord[];
  retention: RetentionConfig;
  now: number;
}

/**
 * Decide which snapshots to keep.
 *
 * Tiered thinning, the same shape as a backup rotation: everything from the last
 * hour, then one per hour for a day, one per day for a fortnight, one per week
 * beyond that. The intuition it encodes is that resolution should decay with age —
 * five minutes ago you want every keystroke, three weeks ago you want "the version
 * from around then".
 *
 * Buckets are fixed windows measured from the epoch rather than from "now", so the
 * plan for a given store is stable between runs instead of shifting every time the
 * command happens to be invoked.
 */
export function planPrune(input: PlanPruneInput): PrunePlan {
  const { records, retention, now } = input;
  const reasons: Record<string, string> = {};
  const keep = new Set<string>();

  const ordered = [...records].sort((a, b) => b.seq - a.seq);

  const latest = ordered[0];
  if (latest !== undefined) {
    keep.add(latest.id);
    reasons[latest.id] = 'most recent snapshot';
  }
  for (const record of ordered) {
    if (record.health?.status === 'healthy') {
      if (!keep.has(record.id)) {
        keep.add(record.id);
        reasons[record.id] = 'most recent snapshot that passed the health check';
      }
      break;
    }
  }

  const keepAllMs = retention.keepAllWithinMinutes * MINUTE;
  const hourlyMs = retention.hourlyForHours * HOUR;
  const dailyMs = retention.dailyForDays * DAY;
  const weeklyMs = retention.weeklyForWeeks * WEEK;
  const claimedBuckets = new Set<string>();

  for (const record of ordered) {
    if (record.pinned) {
      keep.add(record.id);
      reasons[record.id] ??= 'pinned';
      continue;
    }
    if (record.label !== null) {
      keep.add(record.id);
      reasons[record.id] ??= `named "${record.label}"`;
      continue;
    }
    if (keep.has(record.id)) continue;

    const createdAt = Date.parse(record.createdAt);
    // A record with an unparseable timestamp cannot be aged; keeping it is the
    // conservative choice, and `doctor` will surface it.
    if (Number.isNaN(createdAt)) {
      keep.add(record.id);
      reasons[record.id] = 'timestamp could not be read';
      continue;
    }

    const age = now - createdAt;
    if (age <= keepAllMs) {
      keep.add(record.id);
      reasons[record.id] = 'recent';
      continue;
    }

    const tier = tierFor(age, hourlyMs, dailyMs, weeklyMs);
    if (tier === null) {
      reasons[record.id] = 'older than the retention window';
      continue;
    }

    const bucket = `${tier.name}:${Math.floor(createdAt / tier.size)}`;
    if (claimedBuckets.has(bucket)) {
      reasons[record.id] = `superseded by a newer snapshot from the same ${tier.name}`;
      continue;
    }
    claimedBuckets.add(bucket);
    keep.add(record.id);
    reasons[record.id] = `newest snapshot of its ${tier.name}`;
  }

  // Hard ceiling. Applied after tiering so it only ever removes snapshots the tier
  // rules already considered expendable-adjacent, oldest first.
  if (keep.size > retention.maxSnapshots) {
    const evictable = ordered
      .filter((record) => keep.has(record.id) && !record.pinned && record.label === null)
      .reverse();
    let excess = keep.size - retention.maxSnapshots;
    for (const record of evictable) {
      if (excess <= 0) break;
      if (reasons[record.id] === 'most recent snapshot') continue;
      if (reasons[record.id] === 'most recent snapshot that passed the health check') continue;
      keep.delete(record.id);
      reasons[record.id] = `over the ${retention.maxSnapshots} snapshot limit`;
      excess -= 1;
    }
  }

  const drop = ordered.filter((record) => !keep.has(record.id)).map((record) => record.id);
  return { keep: [...keep], drop, reasons };
}

interface Tier {
  name: 'hour' | 'day' | 'week';
  size: number;
}

function tierFor(age: number, hourlyMs: number, dailyMs: number, weeklyMs: number): Tier | null {
  if (age <= hourlyMs) return { name: 'hour', size: HOUR };
  if (age <= hourlyMs + dailyMs) return { name: 'day', size: DAY };
  if (age <= hourlyMs + dailyMs + weeklyMs) return { name: 'week', size: WEEK };
  return null;
}

export interface ApplyPruneInput {
  index: SnapshotIndex;
  store: ObjectStore;
  plan: PrunePlan;
  logger: Logger;
  signal?: AbortSignal;
}

/**
 * Drop the planned snapshots and garbage-collect objects nothing references any more.
 *
 * Mark-and-sweep, and the mark phase is the dangerous one: if any surviving tree
 * cannot be read, the reachable set is incomplete and sweeping would delete live
 * data. In that case the sweep is abandoned entirely. Leaving unreachable objects on
 * disk wastes space; deleting reachable ones destroys the user's history.
 */
export async function applyPrune(input: ApplyPruneInput): Promise<PruneResult> {
  const { index, store, plan, logger } = input;

  if (plan.drop.length === 0) {
    return { droppedSnapshots: 0, deletedObjects: 0, reclaimedBytes: 0 };
  }

  await index.remove(plan.drop);

  const reachable = new Set<string>();
  let markComplete = true;

  for (const record of index.list()) {
    input.signal?.throwIfAborted();
    reachable.add(record.treeHash);
    try {
      const tree = await store.getJson<Tree>(record.treeHash);
      for (const file of tree.files) reachable.add(file.hash);
    } catch (error) {
      markComplete = false;
      logger.warn(
        `Could not read the file list for snapshot ${record.id}; skipping object cleanup this run`,
        error,
      );
      break;
    }
  }

  if (!markComplete) {
    return { droppedSnapshots: plan.drop.length, deletedObjects: 0, reclaimedBytes: 0 };
  }

  let deletedObjects = 0;
  let reclaimedBytes = 0;
  for await (const hash of store.listHashes()) {
    input.signal?.throwIfAborted();
    if (reachable.has(hash)) continue;
    reclaimedBytes += await store.delete(hash);
    deletedObjects += 1;
  }

  logger.debug(`Pruned ${plan.drop.length} snapshots and ${deletedObjects} objects`);
  return { droppedSnapshots: plan.drop.length, deletedObjects, reclaimedBytes };
}
