import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isLoopbackHost } from '../config.js';
import { diffFileLists } from '../core/diff.js';
import type { WatchSession } from '../engine.js';
import { describeUnknownError, isTimeloomError, TimeloomError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Repository } from '../repository.js';
import type { EngineEvent, FileEntry, Tree } from '../types.js';
import { formatBytes } from '../util/fsx.js';
import type {
  ApiDiff,
  ApiError,
  ApiFileContent,
  ApiPruneResponse,
  ApiRestorePreview,
  ApiRestoreResponse,
  ApiSnapshotDetail,
  ApiSnapshotList,
  ApiStatus,
} from './api-types.js';
import { toApiSnapshot } from './present.js';

/** Requests larger than this are rejected outright; every endpoint takes a tiny body. */
const MAX_BODY_BYTES = 64 * 1024;

/** Preview cap for file contents served to the UI. */
const MAX_PREVIEW_BYTES = 512 * 1024;

/** Keeps proxies and browsers from closing an idle event stream. */
const SSE_HEARTBEAT_MS = 25_000;

export interface ServerOptions {
  repository: Repository;
  session: WatchSession | null;
  logger: Logger;
  host: string;
  port: number;
  version: string;
  /** Directory containing the built web UI. Defaults to `<package>/ui`. */
  uiDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  token: string;
  broadcast(event: EngineEvent): void;
  close(): Promise<void>;
}

/**
 * The local HTTP API behind timeloom's web UI.
 *
 * Security posture, which is the interesting part of a localhost server and the part
 * most of them get wrong. This process can overwrite and delete the user's source
 * files on request. A web page the user happens to have open in another tab must not
 * be able to make it do that. Four independent controls:
 *
 *   1. **Loopback binding.** Enforced in config validation, not just here — the
 *      server is unreachable from the network at all.
 *   2. **Host header check.** Defeats DNS rebinding, where an attacker's domain
 *      re-resolves to 127.0.0.1 and their page then talks to us as same-origin.
 *      A request whose Host is not a loopback name is refused regardless of where
 *      the socket came from.
 *   3. **Origin check.** Any cross-origin request is refused outright.
 *   4. **Bearer token.** A fresh random token per run, required on every `/api`
 *      call and compared in constant time. The UI receives it injected into the
 *      page it is served from, so a page from any other origin cannot obtain it —
 *      and, because no CORS headers are ever sent, cannot read a response either.
 *
 * The token is not a defence against other processes on the same machine. Anything
 * running as the same user can read the project directly; there is nothing to
 * protect there.
 */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { repository, logger } = options;

  if (!isLoopbackHost(options.host)) {
    throw new TimeloomError(
      'CONFIG_INVALID',
      `Refusing to bind the UI to ${options.host}: it exposes your source code`,
      { hint: 'Use 127.0.0.1 or localhost.' },
    );
  }

  const token = randomBytes(24).toString('base64url');
  // `fileURLToPath`, not `URL.pathname`: on Windows the latter yields "/C:/..." with
  // percent-escapes, which every subsequent path operation then gets wrong.
  const uiDir = options.uiDir ?? path.resolve(fileURLToPath(import.meta.url), '../../../ui');
  const streams = new Set<ServerResponse>();

  const server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      logger.debug('unhandled request error', error);
      if (!response.headersSent) {
        sendError(response, 500, 'INTERNAL', describeUnknownError(error), null);
      } else {
        response.end();
      }
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    // No CORS headers are emitted anywhere, deliberately. Their absence is what
    // stops a cross-origin page from reading any response.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cache-Control', 'no-store');

    const url = new URL(request.url ?? '/', 'http://localhost');
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      // `decodeURIComponent('/%zz')` throws. That is a malformed request, which is the
      // client's fault — reporting it as a 500 would blame the server for bad input.
      sendError(
        response,
        400,
        'BAD_REQUEST',
        'Malformed percent-encoding in the request path',
        null,
      );
      return;
    }

    const originCheck = checkOrigin(request);
    if (!originCheck.ok) {
      sendError(response, 403, 'FORBIDDEN', originCheck.reason, null);
      return;
    }

    if (!pathname.startsWith('/api/')) {
      // The raw request target, before the URL parser touches it. `url.pathname` is
      // already percent-decoded and dot-segment-normalised, so checking it for
      // encoded separators finds nothing by construction — the very transformation
      // we want to look behind has already happened.
      const rawTarget = (request.url ?? '/').split('?')[0] ?? '/';
      await serveStatic(pathname, rawTarget, response, uiDir, token, logger);
      return;
    }

    if (!hasValidToken(request, url, token)) {
      sendError(
        response,
        401,
        'UNAUTHORIZED',
        'Missing or invalid session token',
        'Open the URL timeloom printed when it started; it carries the token.',
      );
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      // Requiring a JSON content type forces a CORS preflight for any cross-origin
      // attempt, which then fails because we never answer preflights.
      const contentType = request.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('application/json')) {
        sendError(
          response,
          415,
          'UNSUPPORTED_MEDIA_TYPE',
          'Request body must be application/json',
          null,
        );
        return;
      }
    }

    try {
      await route(request, response, url, pathname);
    } catch (error) {
      if (isTimeloomError(error)) {
        sendError(response, statusForCode(error.code), error.code, error.message, error.hint);
        return;
      }
      throw error;
    }
  }

  async function route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    pathname: string,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    const language = repository.config.language;

    if (pathname === '/api/events' && method === 'GET') {
      openEventStream(response, streams, logger);
      return;
    }

    if (pathname === '/api/status' && method === 'GET') {
      const status = await repository.status();
      const payload: ApiStatus = {
        root: status.root,
        projectName: path.basename(status.root),
        snapshotCount: status.snapshotCount,
        latest: status.latest === null ? null : toApiSnapshot(status.latest, language),
        lastHealthy:
          status.lastHealthy === null ? null : toApiSnapshot(status.lastHealthy, language),
        watching: status.daemon !== null,
        watchMode: options.session?.mode ?? null,
        storeBytes: status.storeBytes,
        storeBytesHuman: formatBytes(status.storeBytes),
        objectCount: status.objectCount,
        pendingChanges: status.pendingChanges,
        health: {
          enabled: repository.config.health.enabled,
          command: repository.config.health.command,
        },
        language,
        version: options.version,
      };
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === '/api/snapshots' && method === 'GET') {
      const all = repository.list().reverse();
      const limit = clampInt(url.searchParams.get('limit'), 100, 1, 1_000);
      const offset = clampInt(url.searchParams.get('offset'), 0, 0, Number.MAX_SAFE_INTEGER);
      const payload: ApiSnapshotList = {
        snapshots: all.slice(offset, offset + limit).map((r) => toApiSnapshot(r, language)),
        total: all.length,
      };
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === '/api/snapshots' && method === 'POST') {
      const body = await readJsonBody<{ label?: unknown }>(request);
      const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : null;
      const outcome = await repository.snapshot({
        trigger: 'manual',
        label,
        force: label !== null,
      });
      sendJson(response, 201, {
        snapshot: outcome.snapshot === null ? null : toApiSnapshot(outcome.snapshot, language),
        unchanged: outcome.snapshot === null,
      });
      return;
    }

    if (pathname === '/api/prune' && method === 'POST') {
      const result = await repository.prune();
      const payload: ApiPruneResponse = { result };
      sendJson(response, 200, payload);
      return;
    }

    if (pathname === '/api/diff' && method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      const diff = await repository.diff(from, to);
      const payload: ApiDiff = {
        ...diff,
        fromLabel: from ?? 'nothing',
        toLabel: to ?? 'working files',
      };
      sendJson(response, 200, payload);
      return;
    }

    const snapshotMatch =
      /^\/api\/snapshots\/([^/]+)(?:\/(files|content|restore|restore-preview))?$/.exec(pathname);
    if (snapshotMatch !== null) {
      const reference = snapshotMatch[1] ?? '';
      const action = snapshotMatch[2];
      const record = repository.resolve(reference);

      if (action === undefined && method === 'GET') {
        const files = await repository.filesOf(record);
        const parent = record.parentId === null ? null : repository.get(record.parentId);
        const parentFiles = parent === null ? [] : await repository.filesOf(parent);
        const payload: ApiSnapshotDetail = {
          snapshot: toApiSnapshot(record, language),
          changes: diffFileLists(parentFiles, files),
        };
        sendJson(response, 200, payload);
        return;
      }

      if (action === undefined && method === 'PATCH') {
        const body = await readJsonBody<{ label?: unknown; pinned?: unknown }>(request);
        const patch: { label?: string | null; pinned?: boolean } = {};
        if (typeof body.label === 'string') patch.label = body.label;
        if (body.label === null) patch.label = null;
        if (typeof body.pinned === 'boolean') patch.pinned = body.pinned;
        const updated = await repository.update(record.id, patch);
        sendJson(response, 200, { snapshot: toApiSnapshot(updated, language) });
        return;
      }

      if (action === 'files' && method === 'GET') {
        sendJson(response, 200, { files: await repository.filesOf(record) });
        return;
      }

      if (action === 'content' && method === 'GET') {
        const wanted = url.searchParams.get('path');
        if (wanted === null) {
          sendError(response, 400, 'BAD_REQUEST', 'A `path` query parameter is required', null);
          return;
        }
        sendJson(response, 200, await readSnapshotFile(repository, record.treeHash, wanted));
        return;
      }

      if (action === 'restore-preview' && method === 'GET') {
        const plan = await repository.planRestore(record.id);
        const payload: ApiRestorePreview = {
          targetId: plan.targetId,
          willWrite: plan.write.map((item) => item.change),
          willDelete: plan.delete,
          untouched: plan.untouched.map((item) => ({ path: item.path, reason: item.reason })),
        };
        sendJson(response, 200, payload);
        return;
      }

      if (action === 'restore' && method === 'POST') {
        const body = await readJsonBody<{ dryRun?: unknown }>(request);
        const result = await repository.restore(record.id, {
          dryRun: body.dryRun === true,
        });
        const payload: ApiRestoreResponse = {
          result,
          safetySnapshotId: result.safetySnapshotId,
        };
        sendJson(response, 200, payload);
        return;
      }
    }

    sendError(response, 404, 'NOT_FOUND', `No route for ${method} ${pathname}`, null);
  }

  const heartbeat = setInterval(() => {
    for (const stream of streams) stream.write(': ping\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();

  const actualPort = await listen(server, options.host, options.port);
  const url = `http://${options.host}:${actualPort}/?token=${token}`;
  logger.debug(`UI listening on ${url}`);

  return {
    url,
    port: actualPort,
    token,
    broadcast(event) {
      const payload = `data: ${JSON.stringify(event)}\n\n`;
      for (const stream of streams) {
        stream.write(payload);
      }
    },
    async close() {
      clearInterval(heartbeat);
      for (const stream of streams) stream.end();
      streams.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

function listen(server: Server, host: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address !== null ? address.port : port);
    });
  });
}

interface OriginCheck {
  ok: boolean;
  reason: string;
}

function checkOrigin(request: IncomingMessage): OriginCheck {
  const hostHeader = request.headers.host ?? '';
  const hostname = stripPort(hostHeader);
  if (hostname === '' || !isLoopbackHost(hostname)) {
    return {
      ok: false,
      reason: `Requests must address this server as localhost, not "${hostHeader}"`,
    };
  }

  const origin = request.headers.origin;
  if (origin !== undefined && origin !== 'null') {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      return { ok: false, reason: 'Malformed Origin header' };
    }
    if (!isLoopbackHost(parsed.hostname) || parsed.host !== hostHeader) {
      return { ok: false, reason: `Cross-origin requests are not accepted (from ${origin})` };
    }
  }

  return { ok: true, reason: '' };
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function hasValidToken(request: IncomingMessage, url: URL, expected: string): boolean {
  const header = request.headers['x-timeloom-token'];
  const provided = typeof header === 'string' ? header : (url.searchParams.get('token') ?? '');
  return constantTimeEquals(provided, expected);
}

/** Compare without leaking length or content through timing. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.byteLength !== right.byteLength) return false;
  return timingSafeEqual(left, right);
}

function openEventStream(
  response: ServerResponse,
  streams: Set<ServerResponse>,
  logger: Logger,
): void {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    // Some corporate proxies buffer streamed responses into uselessness.
    'X-Accel-Buffering': 'no',
  });
  response.write(': connected\n\n');
  streams.add(response);
  logger.debug(`event stream opened (${streams.size} total)`);

  const drop = (): void => {
    streams.delete(response);
  };
  response.on('close', drop);
  response.on('error', drop);
}

async function readSnapshotFile(
  repository: Repository,
  treeHash: string,
  wantedPath: string,
): Promise<ApiFileContent> {
  const tree = await repository.objectStore.getJson<Tree>(treeHash);
  const entry: FileEntry | undefined = tree.files.find((file) => file.path === wantedPath);
  if (entry === undefined) {
    throw new TimeloomError('SNAPSHOT_NOT_FOUND', `${wantedPath} is not in this snapshot`);
  }

  const data = await repository.objectStore.get(entry.hash);
  const truncated = data.byteLength > MAX_PREVIEW_BYTES;
  const window = truncated ? data.subarray(0, MAX_PREVIEW_BYTES) : data;

  return {
    path: entry.path,
    size: entry.size,
    text: looksBinary(window) ? null : window.toString('utf8'),
    truncated,
  };
}

/**
 * A NUL byte in the first few kilobytes is the same heuristic git uses, and it is
 * right often enough. The cost of being wrong is a preview the UI refuses to show.
 */
function looksBinary(data: Buffer): boolean {
  const limit = Math.min(data.byteLength, 8_000);
  for (let index = 0; index < limit; index += 1) {
    if (data[index] === 0) return true;
  }
  return false;
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/** Percent-encoded separators and dots, which is how traversal hides from a parser. */
const ENCODED_SEPARATOR = /%2e|%2f|%5c/i;

async function serveStatic(
  pathname: string,
  rawTarget: string,
  response: ServerResponse,
  uiDir: string,
  token: string,
  logger: Logger,
): Promise<void> {
  // Checked against the raw request target, before the URL parser has decoded or
  // normalised anything. Decode-then-resolve is a well-known way to smuggle path
  // segments past a parser, and the only way to notice is to look at what actually
  // arrived on the wire. No legitimate asset path contains these encodings, so
  // refusing them outright costs nothing and removes the whole class.
  if (ENCODED_SEPARATOR.test(rawTarget)) {
    sendError(response, 403, 'FORBIDDEN', 'Encoded path separators are not accepted', null);
    return;
  }

  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const resolved = path.resolve(uiDir, relative);
  const base = path.resolve(uiDir);

  // The load-bearing check: `path.resolve` collapses `..` and, on Windows, treats a
  // backslash as a separator too. Anything landing outside the UI directory stops here.
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    sendError(response, 403, 'FORBIDDEN', 'Path is outside the UI directory', null);
    return;
  }

  const extension = path.extname(resolved).toLowerCase();

  let data: Buffer;
  let servingShell = false;
  try {
    data = await fs.readFile(resolved);
  } catch {
    // A missing path that carries an extension is a missing *asset*. Answering it with
    // the HTML shell would turn a broken image into a silently wrong 200.
    if (extension !== '' && relative !== 'index.html') {
      sendError(response, 404, 'NOT_FOUND', `No such asset: ${relative}`, null);
      return;
    }
    // Extensionless paths are client-side routes; they get the shell.
    try {
      data = await fs.readFile(path.join(base, 'index.html'));
      servingShell = true;
    } catch {
      sendHtml(response, 200, placeholderPage(token));
      return;
    }
  }

  // `servingShell` is load-bearing, not cosmetic. Without it a deep link like
  // `/dashboard` takes the extension-based branch below, gets sent as
  // application/octet-stream — which `nosniff` turns into a download rather than a
  // page — and, worse, never has the session token injected, so even if it rendered
  // it could not call the API. Every client-side route in the UI hits this path.
  if (servingShell || extension === '.html' || relative === 'index.html') {
    sendHtml(response, 200, injectToken(data.toString('utf8'), token));
    logger.debug(`served ${servingShell ? 'index.html (shell)' : relative}`);
    return;
  }

  response.writeHead(200, { 'Content-Type': MIME_TYPES[extension] ?? 'application/octet-stream' });
  response.end(data);
}

/**
 * Hand the page its session token.
 *
 * Injected server-side rather than fetched by the page, so the token never travels
 * through an endpoint that an attacker could also reach.
 */
function injectToken(html: string, token: string): string {
  const snippet = `<script>window.__TIMELOOM__=${JSON.stringify({ token })};</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`);
  return snippet + html;
}

function placeholderPage(token: string): string {
  return injectToken(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>timeloom</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; min-height: 100vh; padding: 2rem; }
  main { max-width: 34rem; }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  code { background: color-mix(in srgb, currentColor 10%, transparent); padding: .1em .35em;
         border-radius: .25rem; }
  p { opacity: .8; }
</style></head><body><main>
<h1>timeloom is running</h1>
<p>The API is live, but no web UI has been installed yet. Drop a built single-page app
into the package's <code>ui/</code> directory and reload.</p>
<p>Every endpoint under <code>/api</code> is documented in <code>docs/http-api.md</code>.
Your session token has been injected as <code>window.__TIMELOOM__.token</code>.</p>
</main></body></html>`,
    token,
  );
}

async function readJsonBody<T>(request: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) {
      throw new TimeloomError('IO', 'Request body is too large');
    }
    chunks.push(buffer);
  }
  if (total === 0) return {} as T;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch (error) {
    throw new TimeloomError('IO', 'Request body is not valid JSON', { cause: error });
  }
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  response.end(html);
}

function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  hint: string | null,
): void {
  const payload: ApiError = { error: { code, message, hint } };
  sendJson(response, status, payload);
}

function statusForCode(code: string): number {
  switch (code) {
    case 'SNAPSHOT_NOT_FOUND':
      return 404;
    case 'AMBIGUOUS_ID':
      return 409;
    case 'LOCK_HELD':
      return 423;
    case 'PATH_ESCAPE':
      return 400;
    case 'NOT_INITIALIZED':
      return 409;
    default:
      return 500;
  }
}
