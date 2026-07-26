import * as path from 'node:path';

/** The directory timeloom creates inside a project. */
export const STORE_DIRNAME = '.timeloom';

export interface RepoPaths {
  /** Absolute path to the project being tracked. */
  root: string;
  /** Absolute path to `<root>/.timeloom`. */
  store: string;
  objects: string;
  tmp: string;
  /** Append-only event log of snapshot records. */
  index: string;
  /** path -> {size, mtimeMs, hash}, so unchanged files are never re-hashed. */
  statCache: string;
  config: string;
  lock: string;
  /** Written by `timeloom watch` so other commands can find the running daemon. */
  daemon: string;
  /** `*` — keeps the store out of git even if the project .gitignore is missing. */
  storeGitignore: string;
}

export function repoPaths(root: string): RepoPaths {
  const absoluteRoot = path.resolve(root);
  const store = path.join(absoluteRoot, STORE_DIRNAME);
  return {
    root: absoluteRoot,
    store,
    objects: path.join(store, 'objects'),
    tmp: path.join(store, 'tmp'),
    index: path.join(store, 'index.jsonl'),
    statCache: path.join(store, 'statcache.json'),
    config: path.join(store, 'config.json'),
    lock: path.join(store, 'lock'),
    daemon: path.join(store, 'daemon.json'),
    storeGitignore: path.join(store, '.gitignore'),
  };
}
