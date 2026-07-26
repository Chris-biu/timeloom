# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-27

First release.

### Added

- **Automatic snapshots.** `timeloom watch` observes the project and snapshots it once
  the tree goes quiet, with a maximum-wait bound so a continuously-churning project
  still gets captured, and a periodic reconciliation scan because recursive file
  watchers drop events under load.
- **Content-addressed storage.** Files are stored under the SHA-256 of their contents
  and deduplicated across every snapshot. A one-byte encoding marker lets
  already-compressed assets skip a counterproductive deflate pass. Reads verify the
  hash by default.
- **Stat cache** with a two-second racily-clean window, so an unchanged file is never
  re-read and a file modified twice within one filesystem timestamp tick is never
  mistaken for a clean one.
- **Health probes.** A configured command decides whether a snapshot "works", with a
  real timeout and process-tree termination on both POSIX and Windows. The result
  distinguishes broken code from a probe that could not start.
- **`restore healthy`** — return to the most recent snapshot that passed its health
  check.
- **Safety snapshots.** Every restore captures the current state first, so a restore is
  itself undoable.
- **Human-readable summaries.** Snapshots are described as e.g. `Edited 3 files in
  src/components · UI`, classified from path analysis, localised in English and
  Simplified Chinese.
- **Complete gitignore implementation** with negation, `**` in all positions,
  character classes, anchoring, and nested ignore files layered so deeper overrides
  shallower. `timeloom why <path>` explains which rule decided a file's fate.
- **Tiered retention.** Everything from the last hour, then hourly for a day, daily for
  a fortnight, weekly beyond that, with mark-and-sweep object garbage collection that
  aborts rather than sweep against an incomplete reachability set.
- **Append-only snapshot index** with replay and compaction, tolerant of a torn final
  line.
- **Local web UI and HTTP API** with server-sent events, protected by loopback-only
  binding, Host header validation, origin checking, and a per-run bearer token compared
  in constant time.
- **CLI**: `init`, `watch`, `snap`, `list`, `show`, `diff`, `check`, `restore`,
  `status`, `label`, `unlabel`, `pin`, `unpin`, `prune`, `doctor`, `why`, `config`.
- **Programmatic API** exported from the package root.
- Zero runtime dependencies.

[Unreleased]: https://github.com/Chris-biu/timeloom/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/Chris-biu/timeloom/releases/tag/v0.1.0
