# Contributing to timeloom

## Getting set up

```bash
npm ci
```

```bash
npm run verify
```

`verify` runs typecheck, lint, format check, tests and build. It is what CI runs. If it
passes locally it should pass there.

Useful during development:

```bash
npm run test:watch
```

```bash
npm run build && node dist/cli/main.js status -C /path/to/some/project
```

## The one rule that is not negotiable

**No runtime dependencies.** `dependencies` in `package.json` stays `{}`.

This is not stylistic. timeloom's audience is people whose first encounter with a
command-line tool should not be an install failure, and its promise is that your files
are safe — which is hard to square with pulling three hundred packages onto the machine
holding them. If you need functionality that seems to require a dependency, write it,
or open an issue and let's discuss whether the feature is worth it.

Dev dependencies are fine. Keep them few.

## Code style

Prettier and ESLint decide formatting and mechanical style; run `npm run lint:fix` and
`npm run format`. Beyond that:

**Comments explain why, never what.** A comment that restates the code is noise. A
comment that records the failure mode a piece of code exists to prevent is the most
valuable thing in the file. Compare:

```ts
// Loop over the files                          <- delete this
for (const file of files) { ... }
```

```ts
// Deletions run before writes so a path that was a file and is now a directory
// can change shape.                            <- keep this
```

Every non-trivial function should say why it exists or what it is defending against.
Several modules here are load-bearing for correctness or security; those get a block
comment at the top explaining the whole design.

**Model absence as `null`, not optional properties**, for anything that gets
serialised. `exactOptionalPropertyTypes` is on and round-tripping through JSON must be
lossless.

**Parse untrusted input into `unknown` and narrow with explicit guards.** Anything read
from disk is untrusted, including timeloom's own store — a user can edit it, and a
malformed record reaching the restore path gets handed to the filesystem.

**No `any`, no `@ts-ignore`, no `@ts-expect-error`** without a comment explaining why
the type system is wrong and what the plan is.

## Tests

Every behavioural change needs a test. Tests live in `test/` as `*.test.ts`.

- Filesystem tests use `fs.mkdtemp` under `os.tmpdir()` and clean up in `afterEach`.
- Anything platform-specific goes behind `describe.skipIf(process.platform === 'win32')`
  with a comment saying why.
- Security properties get adversarial tests. If you touch `resolveWithin`, the ignore
  matcher, or anything under `src/server/`, expect review to focus there.
- Test names should read as the guarantee they assert: `refuses to write through a
symlink`, not `test symlink`.

Coverage thresholds are enforced in CI. Don't lower them; add tests.

## Commits and pull requests

- Branch off `main`.
- Keep the diff focused. A refactor and a behaviour change in one PR is two PRs.
- Add a `CHANGELOG.md` entry under `Unreleased`.
- Fill in the PR template honestly, especially "how was it verified".

## Where things live

```
src/
  core/          the engine: storage, scanning, diffing, restore, prune, watching
  cli/           argument parsing, command implementations, terminal rendering
  server/        the localhost HTTP API and its presentation layer
  util/          filesystem helpers and the config validator
  repository.ts  the facade every entry point goes through
  engine.ts      the long-running watch session (policy: when to snapshot and probe)
docs/            architecture notes and the HTTP API reference
test/            vitest suites, one per module
```

If you are looking for where to start, `src/repository.ts` is the map.

## Reporting bugs

Use the issue templates. Include `timeloom --version`, your OS, and output from a run
with `--log-level debug`.

**Do not paste the contents of `.timeloom/`.** It contains copies of your source files.
