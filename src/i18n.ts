import type { Language } from './config.js';
import type { ChangeCounts, ChangeKind, HealthStatus, SnapshotTrigger } from './types.js';

/**
 * timeloom is aimed squarely at people who are new to building software, and a
 * meaningful share of them are not reading English comfortably. Localising the parts
 * that carry meaning — what a snapshot contains, whether it works, how long ago it
 * was — is not a nicety here; it is the difference between the tool being usable
 * under pressure and not.
 *
 * Scope is deliberate: narrative output is translated, flag names and JSON keys are
 * not. Those are an API.
 */

export interface SummaryInput {
  counts: ChangeCounts;
  scope: string | null;
  kind: ChangeKind;
}

export interface Catalog {
  kindLabel: Record<ChangeKind, string>;
  healthLabel: Record<HealthStatus, string>;
  triggerLabel: Record<SnapshotTrigger, string>;
  /** One line describing what a snapshot contains. */
  summary(input: SummaryInput): string;
  /** "3 minutes ago", "刚刚". `deltaMs` is how long ago, so always non-negative. */
  relativeTime(deltaMs: number): string;
  noChanges: string;
  unknown: string;
}

const EN: Catalog = {
  kindLabel: {
    none: '—',
    ui: 'UI',
    style: 'styling',
    logic: 'logic',
    config: 'config',
    deps: 'dependencies',
    docs: 'docs',
    test: 'tests',
    assets: 'assets',
    mixed: 'mixed',
  },
  healthLabel: {
    healthy: 'working',
    broken: 'broken',
    timeout: 'check timed out',
    error: 'check could not run',
    skipped: 'not checked',
  },
  triggerLabel: {
    init: 'initial',
    manual: 'manual',
    watch: 'auto',
    'pre-restore': 'before restore',
    restore: 'restored',
    reconcile: 'resync',
  },
  summary({ counts, scope, kind }) {
    const parts: { verb: string; count: number }[] = [];
    if (counts.modified > 0) parts.push({ verb: 'edited', count: counts.modified });
    if (counts.added > 0) parts.push({ verb: 'added', count: counts.added });
    if (counts.deleted > 0) parts.push({ verb: 'deleted', count: counts.deleted });

    const [first, ...rest] = parts;
    if (first === undefined) return EN.noChanges;

    // Only the first clause carries the noun: "Edited 1 file, added 2" reads, while
    // "Edited 1, added 2 files" attaches the count to the wrong verb.
    const head = `${capitalize(first.verb)} ${first.count} ${first.count === 1 ? 'file' : 'files'}`;
    const tail = rest.map((part) => `${part.verb} ${part.count}`).join(', ');
    const counted = tail.length === 0 ? head : `${head}, ${tail}`;
    const where = scope === null ? '' : ` in ${scope}`;
    const what = kind === 'none' || kind === 'mixed' ? '' : ` · ${EN.kindLabel[kind]}`;
    return `${counted}${where}${what}`;
  },
  relativeTime(deltaMs) {
    const seconds = Math.max(0, Math.round(deltaMs / 1000));
    if (seconds < 45) return 'just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;
    const days = Math.round(hours / 24);
    if (days === 1) return 'yesterday';
    if (days < 30) return `${days} days ago`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} ${months === 1 ? 'month' : 'months'} ago`;
    return `${Math.round(months / 12)}y ago`;
  },
  noChanges: 'No changes',
  unknown: 'unknown',
};

const ZH: Catalog = {
  kindLabel: {
    none: '—',
    ui: '界面',
    style: '样式',
    logic: '逻辑',
    config: '配置',
    deps: '依赖',
    docs: '文档',
    test: '测试',
    assets: '资源',
    mixed: '综合',
  },
  healthLabel: {
    healthy: '能跑',
    broken: '跑不起来',
    timeout: '检查超时',
    error: '检查没跑成',
    skipped: '未检查',
  },
  triggerLabel: {
    init: '初始',
    manual: '手动',
    watch: '自动',
    'pre-restore': '回滚前',
    restore: '已回滚',
    reconcile: '重新同步',
  },
  summary({ counts, scope, kind }) {
    const parts: string[] = [];
    if (counts.modified > 0) parts.push(`修改 ${counts.modified} 个`);
    if (counts.added > 0) parts.push(`新增 ${counts.added} 个`);
    if (counts.deleted > 0) parts.push(`删除 ${counts.deleted} 个`);
    if (parts.length === 0) return ZH.noChanges;

    const head = `${parts.join('、')}文件`;
    const where = scope === null ? '' : `，位于 ${scope}`;
    const what = kind === 'none' || kind === 'mixed' ? '' : ` · ${ZH.kindLabel[kind]}`;
    return `${head}${where}${what}`;
  },
  relativeTime(deltaMs) {
    const seconds = Math.max(0, Math.round(deltaMs / 1000));
    if (seconds < 45) return '刚刚';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} 分钟前`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} 小时前`;
    const days = Math.round(hours / 24);
    if (days === 1) return '昨天';
    if (days < 30) return `${days} 天前`;
    const months = Math.round(days / 30);
    if (months < 12) return `${months} 个月前`;
    return `${Math.round(months / 12)} 年前`;
  },
  noChanges: '没有改动',
  unknown: '未知',
};

const CATALOGS: Record<Language, Catalog> = {
  en: EN,
  'zh-CN': ZH,
};

export function catalog(language: Language): Catalog {
  return CATALOGS[language];
}

function capitalize(text: string): string {
  const first = text.charAt(0);
  return first === '' ? text : first.toUpperCase() + text.slice(1);
}
