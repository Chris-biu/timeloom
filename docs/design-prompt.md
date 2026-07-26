# Claude Design prompt — timeloom web UI

Paste everything below the line into Claude's design feature. It is self-contained.

When you get the result back, save it as `ui/index.html` (plus any assets) in the
timeloom repository. `timeloom watch --ui` serves that directory automatically and
injects the session token before `</head>`.

---

Build a single-page web UI for **timeloom**, a tool that takes automatic snapshots of
someone's code project so they can rewind to a version that worked.

## Who is using this, and in what state

The user is a beginner. They build software with an AI assistant and have never used
git. They are opening this page because something just broke and they want it to stop
being broken.

That single fact should drive the whole layout. This is not a data-exploration tool.
The most important element on screen is the answer to "how do I get back to when it
worked", and it should be reachable in one click without reading anything first.

Assume they are frightened and skimming. Plain language, no version-control jargon.
Never say "commit", "HEAD", "revision", or "working tree".

## Technical constraints

- **Vanilla HTML/CSS/JS in a single file.** No React, no build step, no bundler.
- **No external requests of any kind.** No CDN scripts, no Google Fonts, no remote
  images. Everything inline. System font stack only. Icons as inline SVG.
- The page is served from `http://127.0.0.1:7317` by a local Node server.
- **Authentication**: the server injects `window.__TIMELOOM__ = { token: "..." }` into
  the page before `</head>`. Every API call must send it:

  ```js
  const TOKEN = window.__TIMELOOM__.token;
  const api = (path, options = {}) =>
    fetch(path, {
      ...options,
      headers: {
        'X-Timeloom-Token': TOKEN,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok)
        throw Object.assign(new Error(data.error?.message ?? r.statusText), data.error ?? {});
      return data;
    });
  ```

  A mutating request **must** send `Content-Type: application/json` or the server
  returns 415.

- Support light and dark via `prefers-color-scheme`.
- Responsive down to a phone width — people check this on a second screen.

## All text is already localised by the server

The API returns pre-formatted, already-translated strings: `summaryText`,
`createdAtRelative`, `statusLabel`, `triggerLabel`, `totalBytesHuman`. **Render them
directly.** Do not build your own date formatter or pluraliser, and do not translate
anything yourself — `/api/status` reports `language` as `"en"` or `"zh-CN"` and the
server has already done the work.

The few UI chrome strings you author yourself (button labels, headings) should have an
`en` and a `zh-CN` variant, selected by that `language` field. Keep the set small.

Important: Chinese text is wider than English. Do not build layouts that assume a
label fits in a fixed pixel width.

## Data model

### `GET /api/status`

```json
{
  "root": "/Users/me/my-app",
  "projectName": "my-app",
  "snapshotCount": 128,
  "latest":      { "...ApiSnapshot..." },
  "lastHealthy": { "...ApiSnapshot..." },
  "watching": true,
  "watchMode": "native",
  "storeBytes": 13012992,
  "storeBytesHuman": "12.4 MiB",
  "objectCount": 1203,
  "pendingChanges": { "added": 1, "modified": 2, "deleted": 0 },
  "health": { "enabled": true, "command": "npm run build" },
  "language": "en",
  "version": "0.1.0"
}
```

`watchMode: "polling"` means file watching degraded to periodic scanning — worth a
quiet notice. `pendingChanges` is work on disk not yet in any snapshot; may be `null`.

### `ApiSnapshot`

```json
{
  "id": "a1b2c3d4",
  "seq": 128,
  "createdAt": "2026-07-27T10:15:00.000Z",
  "createdAtRelative": "3 minutes ago",
  "parentId": "9f8e7d6c",
  "trigger": "watch",
  "triggerLabel": "auto",
  "label": null,
  "pinned": false,
  "fileCount": 47,
  "totalBytes": 319488,
  "totalBytesHuman": "312 KiB",
  "summaryText": "Edited 3 files in src/components · UI",
  "counts": { "added": 0, "modified": 3, "deleted": 0 },
  "samplePaths": ["src/components/Button.tsx", "src/components/Card.tsx"],
  "scope": "src/components",
  "kind": "ui",
  "health": {
    "status": "healthy",
    "statusLabel": "working",
    "command": "npm run build",
    "exitCode": 0,
    "durationMs": 4210,
    "checkedAt": "2026-07-27T10:15:06.000Z",
    "outputTail": ""
  }
}
```

`kind` is one of `none | ui | style | logic | config | deps | docs | test | assets | mixed`.
Give each a distinct, muted accent colour and a small icon — this is what makes the
timeline scannable at a glance.

`health.status` is one of:

| Status    | Meaning                                               | How to show it                                        |
| --------- | ----------------------------------------------------- | ----------------------------------------------------- |
| `healthy` | The project built successfully                        | Green. This is the safe harbour.                      |
| `broken`  | Their code failed to build                            | Red                                                   |
| `timeout` | The check ran too long                                | Amber                                                 |
| `error`   | The check itself couldn't run — usually a bad command | Amber, and say it's a _setup_ problem, not their code |
| `skipped` | Not checked                                           | Neutral grey                                          |
| `null`    | No verdict yet                                        | Neutral, de-emphasised                                |

Do not collapse `broken` and `error` into one colour. They mean completely different
things to the user.

### Other endpoints

| Endpoint                                                      | Returns                                                       |
| ------------------------------------------------------------- | ------------------------------------------------------------- |
| `GET /api/snapshots?limit=100&offset=0`                       | `{ snapshots: ApiSnapshot[], total }` — newest first          |
| `GET /api/snapshots/:id`                                      | `{ snapshot, changes: FileChange[] }` — diff vs parent        |
| `GET /api/snapshots/:id/content?path=…`                       | `{ path, size, text, truncated }` — `text: null` means binary |
| `GET /api/snapshots/:id/restore-preview`                      | `{ targetId, willWrite[], willDelete[], untouched[] }`        |
| `POST /api/snapshots/:id/restore` body `{"dryRun":false}`     | `{ result, safetySnapshotId }`                                |
| `POST /api/snapshots` body `{"label":"name"}`                 | `{ snapshot, unchanged }`                                     |
| `PATCH /api/snapshots/:id` body `{"label":"x","pinned":true}` | `{ snapshot }`                                                |
| `GET /api/diff?from=<id>&to=<id>`                             | omit `to` to compare against files on disk                    |
| `POST /api/prune`                                             | `{ result }`                                                  |

`FileChange` is `{ path, status: "added"|"modified"|"deleted", sizeBefore, sizeAfter, hashBefore, hashAfter }`.

Errors always come back as `{ "error": { "code", "message", "hint" } }`. `hint` is
written for a non-expert — show it verbatim when something fails.

### Live updates

```js
const events = new EventSource(`/api/events?token=${TOKEN}`);
```

Payloads: `{type:"snapshot"}`, `{type:"health", snapshotId, health}`,
`{type:"restore"}`, `{type:"prune"}`, `{type:"watch-status", watching, pendingPaths}`,
`{type:"error", message}`. The simplest correct reaction to any of them is to refetch
`/api/status` and `/api/snapshots`. New snapshots should appear without a reload.

## Screens

### 1. The main view — timeline

A vertical list of snapshots, newest first, grouped under day headings ("Today",
"Yesterday", then dates).

Each row: relative time, the `summaryText`, a health badge, a `kind` accent, and a
label chip or pin marker if present. Rows are clickable.

Above the list, a **persistent safe-harbour banner**. When `lastHealthy` exists, this
is the most important thing on the page:

> **Last version that worked:** 2 hours ago · `Edited 4 files in src/api · logic`
> **[ Go back to this ]**

Make it visually dominant. One click, and it opens the restore preview for
`lastHealthy.id`.

Header strip: project name, a live watching indicator, snapshot count, store size, and
a "Save now" button (`POST /api/snapshots`). If `pendingChanges` is non-null and
non-zero, show it as unsaved work.

### 2. Snapshot detail

Opens as a side panel, not a new page — the timeline should stay visible for context.

Shows the full summary, trigger, file count, size, and the list of `changes` with
+/~/− markers coloured by status. Clicking a file fetches its content and shows it.

If health is `broken` or `timeout`, show `outputTail` in a monospace block, collapsed
by default, with the **last** lines visible first — the error is at the end.

Actions: **Go back to this version**, rename (`PATCH label`), pin/unpin.

### 3. Restore preview — the most important flow

Never restore without showing this first.

```
Go back to: Edited 3 files in src/components · UI   (2 hours ago)

  This will change 12 files and delete 1.

  ~ src/components/Button.tsx
  ~ src/components/Card.tsx
  − src/components/Broken.tsx
  … and 10 more

  ✓ Your current files are saved first, so you can undo this.

  [ Cancel ]                                    [ Go back ]
```

Counts and file lists come from `restore-preview`. Show `untouched` if non-empty —
the user needs to know what is _not_ covered.

The reassurance about the safety snapshot is not decoration. It is the thing that makes
the button clickable.

### 4. After a restore

A prominent, persistent confirmation with an escape hatch:

> ✓ Went back to `a1b2c3d4`. 12 files restored, 1 removed.
> Changed your mind? **[ Undo this ]** — restores `safetySnapshotId`.

Do not use a toast that disappears in three seconds. This is the moment a user most
needs a way out.

### 5. Diff view

Comparing two snapshots, or a snapshot against the current files. File list on the
left, content on the right. A simple line-level diff computed in the browser from the
two `content` responses is fine — no diff library. `text: null` means binary; show a
placeholder rather than rendering it.

### 6. States that are not the happy path

- **No snapshots yet** — explain what to do, in one sentence.
- **Not watching** (`watching: false`) — a clear notice that changes are not being
  captured, and the command to fix it.
- **Loading** — skeleton rows, not a spinner over an empty page.
- **API error** — show `error.message` and `error.hint`, with a retry.
- **Connection lost** (EventSource `onerror`) — a quiet banner; `EventSource`
  reconnects on its own, so don't alarm anyone.

## Visual direction

Calm, dense, and confident. This is a tool someone opens when they're stressed, so it
should feel like a control panel that knows what it's doing — closer to a good status
page than to a consumer app.

Suggestions, not rules: a restrained neutral palette with colour reserved for meaning
(health status and `kind` accents only); generous vertical rhythm in the timeline so
rows are easy to scan; monospace only for paths, ids and command output. Avoid
gradients, avoid decorative illustration, avoid anything that reads as playful. The
one place to spend visual weight is the safe-harbour banner.

Keyboard support is welcome: `↑`/`↓` through the timeline, `Enter` to open, `Esc` to
close the panel.
