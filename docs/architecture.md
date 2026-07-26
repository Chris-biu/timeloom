# Architecture

Notes on why timeloom is built the way it is. For _what_ the commands do, see the
[README](../README.md); for the HTTP surface, see [http-api.md](http-api.md).

---

## The constraint everything follows from

timeloom snapshots on a timer while someone is working. That single fact decides most
of the design:

- Snapshots must be **cheap**, or the user turns the tool off on day two.
- Writes must be **crash-safe**, because the process is running during ordinary
  laptop-lid-closing events, not just during deliberate commands.
- Failures must be **partial**, never total. Losing one snapshot is acceptable; losing
  the history is not.

Nearly every non-obvious decision below traces back to one of those three.

---

## Layers

```
 cli/ ─────────┐
               ├──▶  repository.ts  ──▶  core/*
 server/ ──────┤          ▲
               │          │
 engine.ts ────┘     (the only door)
```

`Repository` is the facade. Every entry point goes through it, which is what lets the
CLI, the HTTP API and the watch daemon share one set of invariants instead of three
subtly different ones.

`engine.ts` holds _policy_ — when to snapshot, when a health check is worth running,
when history has grown enough to thin. `Repository` holds _operations_. Tests drive the
repository directly; only the engine needs timers.

---

## Storage

### Objects

`.timeloom/objects/ab/cdef…` — SHA-256 of the file's contents, sharded two hex
characters deep so no directory accumulates hundreds of thousands of entries.

The deduplication is the whole reason snapshot-on-save is affordable: a file present in
a thousand snapshots exists once on disk, so the marginal cost of a snapshot is the
bytes that actually changed.

Each object begins with a one-byte encoding marker. Source trees are full of PNGs,
WOFF2 and JPEGs; re-deflating them burns CPU to produce a _larger_ file. The marker
lets those be stored raw while text is compressed, decided by measuring rather than by
extension.

`get()` verifies the hash by default. Restore is the operation where writing corrupted
bytes over someone's working files would be unforgivable, and a store that lives for
months on a laptop is not immune to bit rot.

### Trees

The file list of one snapshot, stored as an object like any other, so identical trees
deduplicate too. Sorted by path and containing no timestamps, which is what makes a
tree hash a stable identity for "the project looked exactly like this".

### The index

`.timeloom/index.jsonl` — an append-only log of `add` / `set` / `del` events, replayed
on open.

A rewritten JSON document would be simpler, and it would also mean that a crash during
the rewrite takes the entire history. A torn final line of a log costs one snapshot.
Given that snapshots happen unattended on a timer, that difference decides it.

The log is compacted once it holds roughly twice as many events as live records.

Unknown event kinds are ignored rather than rejected, so a store written by a newer
timeloom stays readable by an older one.

### The stat cache

`path → (size, mtime, hash)`. An unchanged file is never re-read.

This is the difference between a snapshot costing ~40 ms and costing several seconds on
a 5,000-file project.

It also inherits git's **racily clean** problem. A file modified twice within one
filesystem timestamp tick, ending at the same size, is indistinguishable by stat from
an untouched one. timeloom treats anything whose mtime falls within two seconds of the
scan boundary as dirty. That re-hashes exactly the files the user just edited — which
needed hashing anyway — and removes the class of bug where a snapshot silently records
stale content. Being wrong in the expensive direction is the only acceptable direction
here.

---

## Concurrency

The awkward requirement: `timeloom watch` runs for hours, and the user also types
`timeloom restore` in a second terminal.

Content-addressed writes are inherently safe to race — two processes writing the same
bytes under the same name is fine. The index is append-only with `O_APPEND`, so
interleaved lines don't corrupt each other. What is _not_ safe is one process rewriting
the working tree while another reads it, or a garbage collector deleting an object a
concurrent snapshot has just decided to reference.

So there is one exclusive lock, taken **briefly** around snapshot, restore and prune —
never held for the daemon's lifetime. The daemon acquires and releases it per snapshot.
If it loses the race because a restore is in progress, it skips that snapshot and the
next flush picks the change up; that is logged at debug level rather than surfaced,
because it is normal.

Two watchers are prevented separately, by a `daemon.json` holding a pid, checked for
liveness on read.

Stale locks are detected by probing the recorded pid. The subtlety worth knowing:
`process.kill(pid, 0)` throws `ESRCH` when nothing has that pid and `EPERM` when
something does but belongs to another user — so `EPERM` means **alive**, which a naive
try/catch gets backwards. A lock recorded on a different host is never broken, because
a pid from another machine says nothing about this one.

---

## Watching

Three timers, each answering a different way that naive watching fails:

- **Quiet period** (3 s) — an AI agent rewriting fifteen files should produce one
  snapshot at the end, not fifteen snapshots of a half-edited project.
- **Max wait** (45 s) — a project whose dev server writes a log inside the tree never
  goes quiet, and would otherwise never be snapshotted.
- **Reconcile** (5 min) — recursive watchers silently drop events under load, on
  network drives, and inside containers. A periodic full scan is the only honest way to
  guarantee that what is on disk eventually reaches the store.

If `fs.watch({ recursive: true })` is unavailable, the watcher degrades to
reconcile-only polling and says so, rather than failing. Slower snapshots beat no
snapshots.

The watcher and the scanner share one `IgnoreMatcher` instance. When they don't, the
watcher only knows the built-in defaults and every write under a `.gitignore`d
directory wakes it up for nothing.

---

## Ignore matching

A complete gitignore implementation, written from scratch because of the
zero-dependency rule — but getting it _right_ matters more than usual here. A pattern
that matches too much silently stops protecting files; one that matches too little
pulls `node_modules` into every snapshot.

Rules are bucketed by the directory they're rooted at. Matching a path walks its
ancestor chain and only touches the buckets that can possibly apply, instead of
iterating every rule in the project — which turns scanning a monorepo from
O(files × rules) into something proportional to depth.

Evaluation order, weakest to strongest: built-in defaults, then every `.gitignore` in
the tree shallowest-first, then the user's `config.ignore` as a final layer that always
gets the last word. If you tell timeloom to track a file, a `.gitignore` three
directories down should not quietly overrule you.

`decideDirect` skips the ancestor walk and is what the directory walker uses: it tests
each directory before descending, so an ignored directory prunes its whole subtree.
`decide` does the full walk, because gitignore cannot re-include a file whose parent
directory is excluded.

The one documented deviation: POSIX bracket expressions (`[[:alpha:]]`) are treated as
literals. They're legal, they don't appear in practice, and supporting them means
carrying a locale table.

---

## Restore

1. Take a safety snapshot.
2. Scan the working tree.
3. Diff current → target.
4. Delete, then write, then prune emptied directories.

Deletions run first so a path that was a file and is now a directory can change shape.
Empty-directory cleanup runs last rather than during deletion, so a directory about to
be repopulated isn't removed and immediately recreated.

Every write goes through `resolveWithin`, the single chokepoint that rejects absolute
paths, `..` traversal, NUL bytes and Windows reserved device names (`CON`, `NUL`,
`COM1` — writing to one of those doesn't create a file). A store is data, and data from
a store someone else produced must never be able to write outside the project.

Nothing follows a symlink. Restore refuses to write through one or delete one, and
reports it as untouched instead. Following a link is how a write escapes a directory.

Writes are temp-file-plus-rename, with an `EXDEV` fallback to a sibling temp file for
the case where a project subdirectory is on a different mount than `.timeloom/tmp`.

After restoring, a `restore`-triggered record is added pointing at the target tree, so
`latest()` describes what is actually on disk. Without it, the next automatic snapshot
would report the restore as an enormous new edit.

---

## Health probes

The probe distinguishes four outcomes, and the distinction is the point:

| Status    | Means                                    |
| --------- | ---------------------------------------- |
| `healthy` | The command exited with an accepted code |
| `broken`  | The user's code failed to build          |
| `timeout` | It ran too long and was killed           |
| `error`   | The probe itself couldn't start          |

Collapsing `error` into `broken` would have timeloom quietly report every snapshot as
bad after a typo in the configured command — the sort of failure that destroys trust in
a tool silently.

Termination uses two entirely different mechanisms because the platforms have nothing
in common here: on POSIX the child is spawned `detached` so it gets its own process
group, and the group is signalled via a negated pid; on Windows there are no process
groups, so `taskkill /T /F` is the only way to reach the build tool the shell launched.
A plain `child.kill()` orphans it on both.

Output is captured through a fixed-size tail buffer. A runaway build can emit hundreds
of megabytes, and buffering all of it to display the last twenty lines is how a health
check exhausts memory.

Probes are scheduled, not awaited inline: they always target the newest snapshot, are
rate-limited, and an in-flight probe is cancelled the moment it becomes stale. A
verdict about code the user has already changed isn't worth waiting for.

---

## Retention

Tiered thinning, the shape of a backup rotation: everything from the last hour, then
one per hour for a day, one per day for a fortnight, one per week beyond that. The
intuition it encodes is that resolution should decay with age.

Buckets are fixed windows measured from the epoch rather than from "now", so the plan
for a given store is stable between runs instead of shifting every time the command
happens to be invoked.

Always kept regardless of age: the latest snapshot, the latest healthy snapshot,
anything pinned, anything labelled, and anything whose timestamp can't be parsed
(conservative by design).

Object collection is mark-and-sweep, and the mark phase is the dangerous half. If any
surviving tree can't be read, the reachable set is incomplete and sweeping would delete
live data — so the sweep is abandoned entirely. Leaving unreachable objects on disk
wastes space; deleting reachable ones destroys history.

---

## The HTTP server

Reasoning lives in [`SECURITY.md`](../SECURITY.md); the short version is that a
localhost server able to delete source files needs four independent controls, because
any one of them alone has a known bypass:

1. Loopback binding, enforced during config validation.
2. `Host` header validation, against DNS rebinding.
3. `Origin` checking, against cross-origin requests.
4. A per-run bearer token, compared in constant time, injected server-side into the
   page it serves.

Plus: no CORS headers ever, a JSON content type required on mutations (which forces a
preflight that is never answered), and encoded path separators refused before anything
is resolved.

All localisation and formatting happens server-side, in `server/present.ts`. The UI is
generated separately and evolves on its own schedule; handing it pre-rendered strings
means a change to how timeloom describes a snapshot lands everywhere at once instead of
drifting out of sync.

---

## Why the compiler settings are turned all the way up

`noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` are both on, which is more
friction than most projects accept.

The justification is that most of this code manipulates data read from disk — arrays
indexed by parsed input, records that may be missing fields, JSON that a user can edit
by hand — and then hands the result to `fs.rm` and `fs.writeFile`. The failure mode for
a mistake is not a stack trace; it is deleting the wrong file. Absence is modelled as
`null` rather than as an optional property throughout, so a round-trip through
`JSON.stringify` is lossless and the two strictness flags stay satisfiable together.
