# Web UI

This directory holds the single-page app that `timeloom watch --ui` serves.

It is intentionally empty in the repository. Until an `index.html` exists here, the
server answers `/` with a small built-in placeholder, so the API is usable immediately
and the UI can be added later without touching any other code.

## Adding one

1. Run the prompt in [`../docs/design-prompt.md`](../docs/design-prompt.md) through
   Claude's design feature.
2. Save the result as `ui/index.html`, together with any assets it references.
3. `timeloom watch --ui`

## What the server does with these files

- Everything under `ui/` is served as static content.
- `index.html` gets `window.__TIMELOOM__ = { token: "..." }` injected before `</head>`.
  The UI must read the session token from there; every `/api` call needs it.
- An unknown **extensionless** path falls back to `index.html`, so client-side routing
  works. An unknown path *with* an extension returns 404 rather than the HTML shell,
  because answering a missing image with a page is worse than admitting it is missing.
- Percent-encoded path separators are refused outright, and nothing outside this
  directory is ever served.

The full API contract is in [`../docs/http-api.md`](../docs/http-api.md).

## Constraints

The page must be **self-contained**: no CDN scripts, no remote fonts, no external
images. timeloom makes no network requests and neither should its UI — it is meant to
work on a laptop with the wifi off.
