# Security Policy

## Reporting a vulnerability

Please **do not open a public issue**. Use GitHub's private reporting:
**Security → Report a vulnerability** on
<https://github.com/Chris-biu/timeloom/security/advisories/new>.

You should get an acknowledgement within 72 hours.

**Never attach or paste the contents of a `.timeloom/` directory.** It contains full
copies of every version of every tracked file, which for most projects includes
credentials.

## Scope

In scope:

- Any write or delete that lands outside the tracked project directory
- Anything that lets a web page, another origin, or a remote host reach the local
  HTTP API
- Path traversal through a snapshot record, a tree object, or a static asset request
- Code execution triggered by opening a hostile `.timeloom` store or a hostile project
- The session token being obtainable by anything other than the page the server itself
  served
- Secrets escaping the machine by any route

Out of scope:

- Another process running as the same user reading `.timeloom/`. It can read your
  source files directly; there is nothing to protect.
- The health probe running the command you configured. That is its entire job.
- Snapshotting a file you would rather it did not. Use `ignore`, and see
  `timeloom why <path>`.

## Design commitments

These are properties timeloom is built to hold. A break in any of them is a security
bug, not a feature request.

1. **No network access, ever.** timeloom makes no outbound requests of any kind. No
   telemetry, no update checks, no error reporting.
2. **Writes are confined to the project directory.** Every path derived from a
   snapshot record passes through a single chokepoint (`resolveWithin`) that rejects
   absolute paths, `..` traversal, NUL bytes, and Windows reserved device names. A
   store is _data_, and data from a store someone else produced must never be able to
   write outside the project.
3. **Symlinks are never followed or written through.** Restore refuses to write over
   a symlink or delete one, and reports it instead. Following a link is how a write
   escapes a directory.
4. **Object hashes are validated before use as paths.** A hash arriving from a
   snapshot record is untrusted input until it has been shape-checked.
5. **The UI server binds to loopback only.** A non-loopback `server.host` is rejected
   during config validation, not merely discouraged.
6. **The UI server authenticates every API call** with a per-run random token compared
   in constant time, validates the `Host` header against DNS rebinding, refuses
   cross-origin requests, requires a JSON content type on mutations, and emits no CORS
   headers at all.
7. **The store is kept out of version control by two independent mechanisms**:
   `.timeloom/` is appended to the project `.gitignore`, and the store itself contains
   a `.gitignore` holding `*` so it stays ignored even if the project has none.
8. **Zero runtime dependencies.** The install footprint is timeloom's own code plus
   Node.js builtins.

## What timeloom deliberately does not protect against

Snapshots are stored unencrypted on your disk. Full-disk encryption is the right layer
for that, and adding a passphrase would mean an unrecoverable store the first time
someone forgets it — a poor trade for a tool whose purpose is recovery.
