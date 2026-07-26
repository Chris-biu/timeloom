# timeloom HTTP API

The API behind the web UI. Started with:

```bash
timeloom watch --ui
```

It prints a URL of the form `http://127.0.0.1:7317/?token=<token>`.

---

## Authentication

Every request under `/api` requires the session token, supplied either way:

```
X-Timeloom-Token: <token>
```

```
?token=<token>
```

`EventSource` cannot set headers, so `/api/events` takes the query parameter form.

The token is regenerated on every run. A page served by this server receives it as
`window.__TIMELOOM__.token`, injected server-side into the HTML. A UI should read it
from there:

```js
const token = window.__TIMELOOM__.token;

const response = await fetch('/api/status', {
  headers: { 'X-Timeloom-Token': token },
});
```

### Constraints a client must satisfy

These exist because this server can delete the user's source files. See
[`SECURITY.md`](../SECURITY.md) for the reasoning.

| Rule                                             | Consequence of breaking it                                   |
| ------------------------------------------------ | ------------------------------------------------------------ |
| Address the server as `127.0.0.1` or `localhost` | `403` — the `Host` header is validated against DNS rebinding |
| Same-origin requests only                        | `403` on any cross-origin `Origin`                           |
| `Content-Type: application/json` on POST/PATCH   | `415`                                                        |
| Send the token                                   | `401`                                                        |

No CORS headers are ever emitted. This is deliberate: their absence is what prevents a
page from another origin reading a response.

---

## Errors

Every failure returns this envelope:

```json
{
  "error": {
    "code": "SNAPSHOT_NOT_FOUND",
    "message": "No snapshot matches \"abc\"",
    "hint": "Run `timeloom list` to see what is available."
  }
}
```

`hint` is written for a non-expert and is safe to show directly in the UI. It may be
`null`.

| Status | When                                           |
| ------ | ---------------------------------------------- |
| `400`  | Malformed request                              |
| `401`  | Missing or invalid token                       |
| `403`  | Failed a Host, Origin, or path-traversal check |
| `404`  | No such snapshot, file, or route               |
| `409`  | Ambiguous snapshot reference                   |
| `415`  | Wrong content type on a mutation               |
| `423`  | Repository is locked by another operation      |
| `500`  | Unexpected                                     |

---

## Shared shapes

### `ApiSnapshot`

Everything is pre-formatted and pre-localised server-side. A client should render these
strings directly rather than reimplementing timeloom's vocabulary.

```ts
{
  id: string;                  // "a1b2c3d4"
  seq: number;                 // monotonic; use for ordering
  createdAt: string;           // ISO 8601
  createdAtRelative: string;   // "3 minutes ago" / "3 分钟前"
  parentId: string | null;
  trigger: 'init' | 'manual' | 'watch' | 'pre-restore' | 'restore' | 'reconcile';
  triggerLabel: string;        // localised
  label: string | null;        // user-assigned name
  pinned: boolean;
  fileCount: number;
  totalBytes: number;
  totalBytesHuman: string;     // "1.4 MiB"
  summaryText: string;         // "Edited 3 files in src/components · UI"
  counts: { added: number; modified: number; deleted: number };
  samplePaths: string[];       // up to 5, most significant first
  scope: string | null;        // deepest shared directory of the change
  kind: 'none' | 'ui' | 'style' | 'logic' | 'config'
      | 'deps' | 'docs' | 'test' | 'assets' | 'mixed';
  health: ApiHealth | null;
}
```

### `ApiHealth`

```ts
{
  status: 'healthy' | 'broken' | 'timeout' | 'error' | 'skipped';
  statusLabel: string; // localised: "working" / "能跑"
  command: string | null;
  exitCode: number | null;
  durationMs: number;
  checkedAt: string;
  outputTail: string; // last ~8 KiB of combined output
}
```

`broken` means the user's code failed. `error` means the probe itself could not start
— usually a typo in the configured command. A UI should present these differently.

### `FileChange`

```ts
{
  path: string; // repo-relative, forward slashes
  status: 'added' | 'modified' | 'deleted';
  sizeBefore: number | null;
  sizeAfter: number | null;
  hashBefore: string | null;
  hashAfter: string | null;
}
```

---

## Endpoints

### `GET /api/status`

Everything needed to render a dashboard header.

```ts
{
  root: string;
  projectName: string;
  snapshotCount: number;
  latest: ApiSnapshot | null;
  lastHealthy: ApiSnapshot | null;
  watching: boolean;
  watchMode: 'native' | 'polling' | null;
  storeBytes: number;
  storeBytesHuman: string;
  objectCount: number;
  pendingChanges: { added: number; modified: number; deleted: number } | null;
  health: { enabled: boolean; command: string | null };
  language: 'en' | 'zh-CN';
  version: string;
}
```

`pendingChanges` is what has changed on disk since the latest snapshot — the
equivalent of uncommitted work. `watchMode: 'polling'` means recursive file watching
was unavailable and timeloom fell back to periodic scans; worth surfacing.

### `GET /api/snapshots`

Newest first.

Query: `limit` (default 100, max 1000), `offset` (default 0).

```ts
{ snapshots: ApiSnapshot[], total: number }
```

### `POST /api/snapshots`

Take one now.

```json
{ "label": "before refactor" }
```

`label` is optional. Supplying one forces a snapshot even if nothing changed.

`201` →

```ts
{ snapshot: ApiSnapshot | null, unchanged: boolean }
```

`unchanged: true` with `snapshot: null` means the tree was byte-identical to the last
snapshot and nothing was recorded.

### `GET /api/snapshots/:ref`

`:ref` accepts anything the CLI accepts: a full id, a unique prefix, `latest`,
`healthy`, `~3`, `#42`, or a label.

```ts
{ snapshot: ApiSnapshot, changes: FileChange[] }
```

`changes` is the diff against the parent snapshot.

### `PATCH /api/snapshots/:ref`

```json
{ "label": "keep this one", "pinned": true }
```

Both fields optional. `label: null` clears the name. Labelled and pinned snapshots are
never removed by retention.

```ts
{
  snapshot: ApiSnapshot;
}
```

### `GET /api/snapshots/:ref/files`

```ts
{
  files: Array<{ path: string; hash: string; size: number; executable: boolean }>;
}
```

### `GET /api/snapshots/:ref/content?path=<repo-relative-path>`

The contents of one file as it was in that snapshot.

```ts
{
  path: string;
  size: number;
  text: string | null; // null when the file is binary
  truncated: boolean; // true past 512 KiB
}
```

`text: null` means a NUL byte was found in the first 8 KB. Show a "binary file"
placeholder rather than rendering it.

`404` if the path is not in that snapshot.

### `GET /api/snapshots/:ref/restore-preview`

What a restore would do, without doing it.

```ts
{
  targetId: string;
  willWrite: FileChange[];
  willDelete: FileChange[];
  untouched: Array<{ path: string; reason: string }>;
}
```

`untouched` lists files present on disk that restore will deliberately leave alone
(too large to track, symlinks, unreadable). Show it — a user needs to know what is
_not_ covered.

### `POST /api/snapshots/:ref/restore`

```json
{ "dryRun": false }
```

```ts
{
  result: {
    targetId: string;
    safetySnapshotId: string | null;
    written: number;
    deleted: number;
    bytesWritten: number;
    durationMs: number;
  },
  safetySnapshotId: string | null
}
```

A safety snapshot is always taken first. `safetySnapshotId` is what to pass to
`POST /api/snapshots/<id>/restore` to undo the undo — a UI should offer exactly that,
prominently, immediately after a restore.

### `GET /api/diff?from=<ref>&to=<ref>`

Omit `to` to compare against the working tree as it is right now.

```ts
{
  fromId: string | null;
  toId: string | null;
  fromLabel: string;
  toLabel: string;
  changes: FileChange[];
  counts: { added: number; modified: number; deleted: number };
}
```

### `POST /api/prune`

Apply the retention policy.

```ts
{
  result: {
    droppedSnapshots: number;
    deletedObjects: number;
    reclaimedBytes: number;
  }
}
```

### `GET /api/events`

Server-sent events. Token via query parameter.

```js
const events = new EventSource(`/api/events?token=${window.__TIMELOOM__.token}`);
events.onmessage = (message) => {
  const event = JSON.parse(message.data);
  // ...
};
```

Each `data:` payload is one of:

```ts
{ type: 'snapshot',     snapshot: SnapshotRecord }
{ type: 'health',       snapshotId: string, health: HealthResult }
{ type: 'restore',      result: RestoreResult }
{ type: 'prune',        result: PruneResult }
{ type: 'watch-status', watching: boolean, pendingPaths: number }
{ type: 'error',        message: string }
```

Note that `snapshot` here is the **internal** `SnapshotRecord`, not the pre-formatted
`ApiSnapshot`. It carries the same information but without the localised strings; the
simplest correct reaction to any event is to refetch `/api/snapshots`.

A comment line (`: ping`) arrives every 25 seconds to keep the connection open.
`EventSource` reconnects on its own.

---

## Static assets

Anything not under `/api` is served from the package's `ui/` directory.
`index.html` gets `window.__TIMELOOM__` injected before `</head>`. Unknown paths fall
back to `index.html` so client-side routing works.

Percent-encoded path separators (`%2e`, `%2f`, `%5c`) are refused with `403` before
anything is resolved, and any path resolving outside `ui/` is refused as well.
