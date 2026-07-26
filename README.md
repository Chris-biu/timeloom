<div align="center">

# timeloom

**Automatic snapshots of your project, so you can always go back.**

Built for people who ship with AI assistants and have never used git.

[![CI](https://github.com/Chris-biu/timeloom/actions/workflows/ci.yml/badge.svg)](https://github.com/Chris-biu/timeloom/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520.13-brightgreen.svg)](https://nodejs.org)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](#zero-dependencies-on-purpose)

[English](README.md) · [简体中文](README.zh-CN.md)

</div>

---

## The problem

You asked the AI to change one small thing. It touched nine files. Now the app won't
start, undo has run out of history, and you can't remember what the login page looked
like an hour ago.

Git solves this. Git also asks you to have already known about git, to have committed
before things broke, and to know what `HEAD~3` means at the exact moment you are
least equipped to learn it.

timeloom takes the snapshot for you, whether or not you remembered to.

```bash
timeloom restore healthy
```

That command puts every file back to the last version that actually built. It works
even if you have never made a commit in your life.

---

## Quick start

```bash
npx timeloom init
```

```bash
npx timeloom watch
```

Leave that running in a terminal while you work. That's the whole setup.

When something breaks:

```bash
npx timeloom restore healthy
```

Or browse your history visually:

```bash
npx timeloom watch --ui
```

---

## What makes it different

**It knows which versions worked.** timeloom runs your build (or typecheck, or lint)
in the background after snapshots and records the verdict. `restore healthy` is not
"an hour ago" — it's _the last version that compiled_. Nothing else in this space
does this, and it turns the panic question ("when did it break?") into a command.

**It describes changes in language you recognise.** Not `a3f9c2e — 7 files changed`,
but `Edited 3 files in src/components · UI`. Snapshots are classified by what they
touched — UI, styling, dependencies, config — from path analysis alone, so scanning
your history feels like scanning your afternoon.

**Snapshotting is nearly free.** Content-addressed storage with a stat cache means the
marginal cost of a snapshot is the bytes that actually changed. On a 5,000 file
project a snapshot costs single-digit milliseconds, which is what makes
snapshot-on-every-save practical instead of something you turn off on day two.

**Undo is always undoable.** Every restore takes a safety snapshot first. There is no
sequence of timeloom commands that loses your work.

**It speaks your language.** Summaries, timestamps and health verdicts are localised.
Terminal tables align correctly with Chinese text, which sounds trivial until you've
used a tool that gets it wrong.

---

## Commands

### Getting started

| Command                    | What it does                                                    |
| -------------------------- | --------------------------------------------------------------- |
| `timeloom init`            | Start tracking this folder                                      |
| `timeloom watch [--ui]`    | Watch for changes and snapshot automatically. Leave it running. |
| `timeloom restore healthy` | Go back to the last version that passed its health check        |

### Looking around

| Command                         | What it does                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `timeloom status`               | What's going on with this project                               |
| `timeloom list [-n 20] [--all]` | Recent snapshots                                                |
| `timeloom show <ref>`           | What a snapshot contains                                        |
| `timeloom diff [from] [to]`     | Compare snapshots, or a snapshot against your current files     |
| `timeloom check [ref]`          | Run the health command now and record the verdict               |
| `timeloom why <path>`           | Explain whether a file is being tracked, and which rule decided |

### Saving and restoring

| Command                                      | What it does                                             |
| -------------------------------------------- | -------------------------------------------------------- |
| `timeloom snap [-m "name"]`                  | Take a snapshot right now                                |
| `timeloom restore <ref> [--dry-run] [--yes]` | Put your files back to a snapshot                        |
| `timeloom label <ref> <name>`                | Name a snapshot. Named snapshots are never auto-deleted. |
| `timeloom pin <ref>` / `unpin <ref>`         | Keep a snapshot forever                                  |

### Housekeeping

| Command                         | What it does                          |
| ------------------------------- | ------------------------------------- |
| `timeloom prune [--dry-run]`    | Thin out old snapshots                |
| `timeloom doctor [--deep]`      | Check the snapshot store for problems |
| `timeloom config [key] [value]` | Read or change settings               |

### Referring to a snapshot

Anywhere a command takes `<ref>`, all of these work:

| Reference           | Means                                        |
| ------------------- | -------------------------------------------- |
| `a1b2c3d4`          | A full id — or just the first few characters |
| `latest`            | The newest snapshot                          |
| `healthy`           | The newest one that passed its health check  |
| `~3`                | Three snapshots back                         |
| `"before refactor"` | A snapshot you labelled                      |
| `#42`               | Sequence number 42                           |

---

## How it works

```
                  ┌─────────────┐
   file events ──▶│   watcher   │──┐  quiet period · max wait · reconcile
                  └─────────────┘  │
                                   ▼
                  ┌─────────────────────────┐
                  │  scanner + stat cache   │  only re-hashes what changed
                  └────────────┬────────────┘
                               ▼
      ┌────────────────────────────────────────────┐
      │  content-addressed object store (sha256)    │  identical bytes stored once
      └────────────┬───────────────────────────────┘
                   ▼
      ┌────────────────────────┐      ┌──────────────────┐
      │  append-only index log │◀────▶│   health probe   │
      └────────────────────────┘      └──────────────────┘
```

### Content-addressed storage

Every file is stored under the SHA-256 of its contents, sharded two hex characters
deep the way git does it. A file that appears in a thousand snapshots is stored once.
Objects carry a one-byte encoding marker so already-compressed assets (PNG, WOFF2)
skip a pointless deflate round-trip that would make them _larger_.

Reads verify the hash by default. Restore is the one operation where silently writing
corrupted bytes over your working files would be unforgivable, and bit rot in a store
that lives for months is not hypothetical.

### The stat cache, and the bug it avoids

A file whose size and mtime are unchanged doesn't get re-read. That's the difference
between a snapshot costing 40ms and costing several seconds.

It also introduces git's "racily clean" problem: a file modified twice within the same
filesystem timestamp tick, ending at the same size, is indistinguishable from an
unmodified one. timeloom treats anything touched within two seconds of the scan
boundary as dirty. That costs one re-hash of files you just edited — exactly the set
that needed hashing anyway — and removes the class of bug where a snapshot silently
records stale content.

### Append-only index

Snapshot records go into a log, not a rewritten document. Snapshots happen on a timer
while you work, so the write path has to be crash-safe: a half-written JSON document
takes your whole history with it, whereas a torn final log line costs one snapshot.
The log is replayed on open and compacted once redundancy builds up.

### Health probes

The configured command runs with a real timeout and a real process-tree kill — a
negated-pid signal to the process group on POSIX, `taskkill /T` on Windows, because
`child.kill()` leaves the build tool your shell launched running forever.

The result distinguishes four outcomes, because they mean different things to you:
`healthy`, `broken` (your code doesn't build), `timeout`, and `error` (the probe
itself couldn't start — usually a typo in the command). Conflating the last two would
have timeloom quietly report every snapshot as bad.

### The ignore matcher

A complete gitignore implementation, written from scratch: negation with
last-match-wins, `**` in leading, trailing and interior position, character classes,
anchoring rules, and nested `.gitignore` files layered so a deeper one overrides a
shallower one. Rules are bucketed by the directory they're rooted at, so matching a
path only touches the handful of rules that could possibly apply rather than every
rule in the project.

`timeloom why <path>` will tell you exactly which rule in which file decided a file's
fate.

---

## Configuration

Settings live in `.timeloom/config.json`. Change them with `timeloom config`:

```bash
timeloom config health.command "npm run build"
```

```bash
timeloom config watch.quietPeriodMs 5000
```

| Key                              | Default       | What it controls                                            |
| -------------------------------- | ------------- | ----------------------------------------------------------- |
| `health.command`                 | auto-detected | The command that decides whether a snapshot "works"         |
| `health.timeoutMs`               | `120000`      | How long the probe may run before being killed              |
| `health.minIntervalMs`           | `60000`       | Never probe more often than this                            |
| `watch.quietPeriodMs`            | `3000`        | How long the tree must be still before snapshotting         |
| `watch.maxWaitMs`                | `45000`       | Snapshot anyway after this long, however busy the tree      |
| `watch.reconcileIntervalMs`      | `300000`      | Full rescan interval, to catch dropped watcher events       |
| `maxFileBytes`                   | `5242880`     | Files larger than this aren't tracked                       |
| `ignore`                         | `[]`          | Extra gitignore-style patterns. Wins over any `.gitignore`. |
| `useGitignore`                   | `true`        | Honour the project's own `.gitignore` files                 |
| `retention.keepAllWithinMinutes` | `60`          | Keep every snapshot this recent                             |
| `retention.hourlyForHours`       | `24`          | Then one per hour, for this long                            |
| `retention.dailyForDays`         | `14`          | Then one per day                                            |
| `retention.weeklyForWeeks`       | `8`           | Then one per week                                           |
| `retention.maxSnapshots`         | `2000`        | Hard ceiling                                                |
| `server.port`                    | `7317`        | Port for the web UI                                         |
| `language`                       | auto-detected | `en` or `zh-CN`                                             |

Retention is tiered the way a backup rotation is: resolution decays with age. Five
minutes ago you want every keystroke; three weeks ago you want "the version from
around then".

---

## The web UI

```bash
timeloom watch --ui
```

Prints a URL. The page shows your timeline, which snapshots built cleanly, a diff
viewer, and one-click restore, updating live over server-sent events.

The API behind it is documented in [`docs/http-api.md`](docs/http-api.md) and is
stable enough to build against.

### Why the localhost server is locked down

A local server that can delete your source files is a serious thing to leave running.
Four independent controls, because any one of them can be bypassed in isolation:

1. **Loopback binding**, enforced at config-validation time. A non-loopback `host` is
   rejected outright, so the server is unreachable from the network at all.
2. **Host header validation.** Defeats DNS rebinding, where an attacker's domain
   re-resolves to `127.0.0.1` and their page then talks to you as same-origin.
3. **Origin checking.** Any cross-origin request is refused.
4. **A per-run bearer token**, compared in constant time, required on every `/api`
   call. The UI receives it injected server-side into the page it's served from, so a
   page from any other origin can't obtain it — and since no CORS headers are ever
   sent, can't read a response either.

The token isn't a defence against other processes on your own machine. Anything
running as you can read the project directly; there's nothing to protect there.

---

## Security and privacy

**Nothing leaves your machine.** timeloom makes no network requests. There is no
telemetry, no account, no cloud.

**`.timeloom/` contains full copies of every version of every tracked file** — which
includes your `.env` if you have one. Two things protect you from publishing it:
`init` appends `.timeloom/` to your `.gitignore`, and the store contains its own
`.gitignore` holding `*`, which works even if your project has no `.gitignore` at all.

If you file a bug report, **do not paste the contents of `.timeloom/`**.

Full policy: [`SECURITY.md`](SECURITY.md).

---

## Zero dependencies, on purpose

`npm install timeloom` installs timeloom and nothing else. No transitive tree, no
audit noise, no install-time surprises.

This costs real work — the gitignore matcher, the CLI argument handling, the HTTP
server and the terminal width calculation are all hand-written — and buys two things
that matter for this audience specifically. A beginner's first encounter with a tool
should not be an install failure. And a tool whose entire promise is "your files are
safe" has no business pulling three hundred packages onto the machine holding them.

---

## timeloom and git

They're not alternatives. timeloom is a safety net under your working directory; git
is how you publish and collaborate.

|                           | timeloom                | git                                         |
| ------------------------- | ----------------------- | ------------------------------------------- |
| Who decides when to save  | It does, automatically  | You do                                      |
| Knows if a version worked | Yes, it runs your build | No                                          |
| Needed to use it          | Nothing                 | Understanding of commits, branches, staging |
| Good for                  | Undoing the last hour   | History, collaboration, releases            |
| Should you use both       | Yes                     | Yes                                         |

If you already use git, timeloom fills the gap between commits — the hours where
you're mid-thought and haven't committed because it isn't finished yet.

---

## Programmatic use

```ts
import { Repository } from 'timeloom';

const repo = await Repository.open(process.cwd());

await repo.snapshot({ trigger: 'manual', label: 'before refactor' });
await repo.restore('healthy');

const status = await repo.status();
console.log(status.lastHealthy?.id);
```

Everything the CLI does goes through this API. Editor extensions and custom dashboards
are the intended consumers.

---

## FAQ

**Does this replace git?**
No. See above. Use both.

**Will it slow down my machine?**
Snapshots are incremental and typically take milliseconds. The health probe runs your
build, which costs whatever your build costs, but it's rate-limited and cancelled the
moment it goes stale.

**How much disk does it use?**
Roughly your project size plus the bytes that changed over time. `timeloom status`
tells you exactly. `timeloom prune` thins old history.

**What if it misses a change?**
Recursive file watchers do drop events under load and on network drives. timeloom does
a full reconciliation scan every five minutes for exactly this reason, and falls back
to periodic scanning entirely if recursive watching isn't available.

**Can I track my `.env`?**
It is tracked by default, because deleting one is a common and painful mistake. The
store is kept out of git by two independent mechanisms. If you'd rather not, add
`.env` to `ignore` in the config.

**Something is corrupted.**
`timeloom doctor --deep` verifies every stored object against its hash and tells you
which snapshots are affected. Newer snapshots are generally unaffected.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). The short version: `npm run verify` must
pass, tests come with the change, and **no new runtime dependencies** — that constraint
is the project, not a preference.

## License

MIT © Chris-biu
