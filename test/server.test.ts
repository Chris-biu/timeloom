import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { defaultConfig } from '../src/config.js';
import { silentLogger } from '../src/logger.js';
import { Repository } from '../src/repository.js';
import type {
  ApiError,
  ApiFileContent,
  ApiRestorePreview,
  ApiSnapshot,
  ApiSnapshotDetail,
  ApiSnapshotList,
  ApiStatus,
} from '../src/server/api-types.js';
import { startServer, type RunningServer } from '../src/server/http.js';

/**
 * Tests for the local HTTP API.
 *
 * Everything here talks to the server over a raw `node:net` socket rather than
 * `fetch`. undici normalises the request target and forbids setting `Host`, so the
 * two controls that matter most — the DNS-rebinding guard and the traversal guard —
 * cannot be expressed through `fetch` at all.
 */

/** Written to files that live OUTSIDE the served UI directory. Must never be served. */
const SENTINEL = 'TIMELOOM-SENTINEL-OUTSIDE-THE-UI-DIRECTORY';

interface RawResponse {
  status: number;
  headers: Map<string, string>;
  body: string;
}

interface CreateSnapshotResponse {
  snapshot: ApiSnapshot | null;
  unchanged: boolean;
}

interface PatchSnapshotResponse {
  snapshot: ApiSnapshot;
}

function parseResponse(raw: string): RawResponse {
  const separator = raw.indexOf('\r\n\r\n');
  const head = separator === -1 ? raw : raw.slice(0, separator);
  let body = separator === -1 ? '' : raw.slice(separator + 4);

  const [statusLine = '', ...headerLines] = head.split('\r\n');
  const match = /^HTTP\/1\.[01] (\d{3})/.exec(statusLine);
  if (match === null) {
    throw new Error(`not an HTTP response: ${JSON.stringify(raw.slice(0, 200))}`);
  }

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }

  if ((headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked')) {
    body = dechunk(body);
  }

  return { status: Number.parseInt(match[1] ?? '0', 10), headers, body };
}

/** Bodies in these tests are ASCII, so string-level de-chunking is safe. */
function dechunk(raw: string): string {
  let rest = raw;
  let out = '';
  for (;;) {
    const eol = rest.indexOf('\r\n');
    if (eol === -1) return out + rest;
    const size = Number.parseInt(rest.slice(0, eol).split(';')[0] ?? '', 16);
    if (Number.isNaN(size)) return out + rest;
    if (size === 0) return out;
    out += rest.slice(eol + 2, eol + 2 + size);
    rest = rest.slice(eol + 2 + size + 2);
  }
}

/**
 * Send a request byte for byte and read the whole response.
 *
 * `lines` is the request line followed by header lines; the blank line and body are
 * appended here. Callers include `Connection: close` so the server closes the socket
 * and the response is known to be complete.
 */
function rawRequest(port: number, lines: readonly string[], body = ''): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error !== null) {
        reject(error);
        return;
      }
      try {
        resolve(parseResponse(Buffer.concat(chunks).toString('utf8')));
      } catch (parseError) {
        reject(parseError instanceof Error ? parseError : new Error(String(parseError)));
      }
    };

    socket.setTimeout(10_000, () => {
      finish(new Error(`raw request timed out: ${lines[0] ?? '<no request line>'}`));
    });
    socket.on('error', (error) => {
      finish(error);
    });
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    socket.on('close', () => {
      finish(null);
    });
    socket.on('connect', () => {
      socket.write(`${lines.join('\r\n')}\r\n\r\n${body}`);
    });
  });
}

/** Poll a predicate with a hard deadline, so a broken stream fails instead of hanging. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

describe('the local HTTP API', () => {
  let tempRoot: string;
  let projectRoot: string;
  let packageDir: string;
  let uiDir: string;
  let repository: Repository | undefined;
  let running: RunningServer | undefined;
  const openSockets: net.Socket[] = [];

  function srv(): RunningServer {
    if (running === undefined) throw new Error('server was not started');
    return running;
  }

  function repo(): Repository {
    if (repository === undefined) throw new Error('repository was not opened');
    return repository;
  }

  /** Request line + a loopback Host + `Connection: close`, the common prefix. */
  function baseLines(method: string, target: string): string[] {
    return [`${method} ${target} HTTP/1.1`, `Host: 127.0.0.1:${srv().port}`, 'Connection: close'];
  }

  async function get(target: string, extra: readonly string[] = []): Promise<RawResponse> {
    return rawRequest(srv().port, [
      ...baseLines('GET', target),
      `X-Timeloom-Token: ${srv().token}`,
      ...extra,
    ]);
  }

  async function sendJson(
    method: string,
    target: string,
    payload: unknown,
    extra: readonly string[] = [],
  ): Promise<RawResponse> {
    const body = JSON.stringify(payload);
    return rawRequest(
      srv().port,
      [
        ...baseLines(method, target),
        `X-Timeloom-Token: ${srv().token}`,
        'Content-Type: application/json',
        `Content-Length: ${Buffer.byteLength(body)}`,
        ...extra,
      ],
      body,
    );
  }

  /**
   * Parse a response body as the API shape the endpoint documents. The caller names
   * the expected wire shape, which is the whole point of the helper.
   */
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
  function bodyOf<T>(response: RawResponse): T {
    return JSON.parse(response.body) as T;
  }

  async function totalSnapshots(): Promise<number> {
    const response = await get('/api/snapshots?limit=1');
    expect(response.status).toBe(200);
    return bodyOf<ApiSnapshotList>(response).total;
  }

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'timeloom-server-'));
    projectRoot = path.join(tempRoot, 'project');
    // Mirrors the real layout: the UI directory sits next to a package.json, so a
    // successful `../..` escape would land on a real file.
    packageDir = path.join(tempRoot, 'pkg');
    uiDir = path.join(packageDir, 'ui');

    await fs.mkdir(projectRoot, { recursive: true });
    await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
    await fs.mkdir(uiDir, { recursive: true });

    // Bait one level up from the UI dir and two levels up, covering both traversal depths.
    await fs.writeFile(path.join(packageDir, 'package.json'), SENTINEL, 'utf8');
    await fs.writeFile(path.join(tempRoot, 'package.json'), SENTINEL, 'utf8');

    await fs.writeFile(path.join(projectRoot, 'index.js'), 'console.log("hello");\n', 'utf8');
    await fs.writeFile(path.join(projectRoot, 'src', 'app.ts'), 'export const app = 1;\n', 'utf8');
    await fs.writeFile(
      path.join(projectRoot, 'data.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x01, 0x02]),
    );

    repository = await Repository.init(projectRoot, {
      logger: silentLogger,
      config: defaultConfig('en'),
      updateGitignore: false,
    });

    running = await startServer({
      repository,
      session: null,
      logger: silentLogger,
      host: '127.0.0.1',
      port: 0,
      version: '9.9.9-test',
      uiDir,
    });
  });

  afterEach(async () => {
    for (const socket of openSockets.splice(0)) socket.destroy();
    try {
      await running?.close();
    } finally {
      running = undefined;
      try {
        await repository?.close();
      } finally {
        repository = undefined;
        await fs.rm(tempRoot, { recursive: true, force: true, maxRetries: 5 });
      }
    }
  });

  // ---------------------------------------------------------------------------
  // Bearer token
  // ---------------------------------------------------------------------------

  describe('session token', () => {
    it('refuses an /api request that carries no token at all with 401', async () => {
      const response = await rawRequest(srv().port, baseLines('GET', '/api/status'));

      expect(response.status).toBe(401);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('UNAUTHORIZED');
      expect(payload.error.hint).not.toBeNull();
    });

    it('refuses an /api request whose token is wrong with 401', async () => {
      const wrong = 'z'.repeat(srv().token.length);
      const response = await rawRequest(srv().port, baseLines('GET', `/api/status?token=${wrong}`));

      expect(response.status).toBe(401);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNAUTHORIZED');
    });

    it('accepts a valid token supplied as the ?token= query parameter', async () => {
      const response = await rawRequest(
        srv().port,
        baseLines('GET', `/api/status?token=${srv().token}`),
      );

      expect(response.status).toBe(200);
      expect(bodyOf<ApiStatus>(response).version).toBe('9.9.9-test');
    });

    it('accepts a valid token supplied in the X-Timeloom-Token header', async () => {
      const response = await rawRequest(srv().port, [
        ...baseLines('GET', '/api/status'),
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      expect(response.status).toBe(200);
      expect(bodyOf<ApiStatus>(response).version).toBe('9.9.9-test');
    });

    it('refuses a token that is a proper prefix of the real one with 401', async () => {
      const prefix = srv().token.slice(0, -1);
      expect(prefix.length).toBeLessThan(srv().token.length);

      const response = await rawRequest(srv().port, [
        ...baseLines('GET', '/api/status'),
        `X-Timeloom-Token: ${prefix}`,
      ]);

      expect(response.status).toBe(401);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNAUTHORIZED');
    });

    it('refuses a token that is longer than the real one with 401', async () => {
      const response = await rawRequest(srv().port, [
        ...baseLines('GET', '/api/status'),
        `X-Timeloom-Token: ${srv().token}extra`,
      ]);

      expect(response.status).toBe(401);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNAUTHORIZED');
    });

    it('serves the UI shell without a token, since that is how the page receives one', async () => {
      const response = await rawRequest(srv().port, baseLines('GET', '/'));

      expect(response.status).toBe(200);
      expect(response.body).toContain('window.__TIMELOOM__');
    });
  });

  // ---------------------------------------------------------------------------
  // Host header / DNS rebinding
  // ---------------------------------------------------------------------------

  describe('Host header check (DNS rebinding)', () => {
    it('refuses a request whose Host is an attacker-controlled domain with 403', async () => {
      const response = await rawRequest(srv().port, [
        'GET /api/status HTTP/1.1',
        'Host: evil.example.com',
        'Connection: close',
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      expect(response.status).toBe(403);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('FORBIDDEN');
      expect(payload.error.message).toContain('evil.example.com');
    });

    it('refuses a request whose Host is a non-loopback IP address with 403', async () => {
      const response = await rawRequest(srv().port, [
        'GET /api/status HTTP/1.1',
        'Host: 203.0.113.9',
        'Connection: close',
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
    });

    it('accepts a request whose Host is 127.0.0.1 with the listening port', async () => {
      const response = await rawRequest(srv().port, [
        'GET /api/status HTTP/1.1',
        `Host: 127.0.0.1:${srv().port}`,
        'Connection: close',
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      expect(response.status).toBe(200);
    });

    it('accepts a request whose Host is localhost with the listening port', async () => {
      const response = await rawRequest(srv().port, [
        'GET /api/status HTTP/1.1',
        `Host: localhost:${srv().port}`,
        'Connection: close',
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      expect(response.status).toBe(200);
    });

    it('never serves a request that omits the Host header', async () => {
      const response = await rawRequest(srv().port, [
        'GET /api/status HTTP/1.1',
        'Connection: close',
        `X-Timeloom-Token: ${srv().token}`,
      ]);

      // Node's own parser rejects a Host-less HTTP/1.1 request with 400 before the
      // handler runs, so the Host check never sees it. Either way it must not be
      // answered: what matters is that no status payload comes back.
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.body).not.toContain('storeBytesHuman');
    });
  });

  // ---------------------------------------------------------------------------
  // Origin / CORS
  // ---------------------------------------------------------------------------

  describe('cross-origin requests', () => {
    it('refuses a cross-origin GET with 403 even when the token is correct', async () => {
      const response = await get('/api/status', ['Origin: https://evil.example.com']);

      expect(response.status).toBe(403);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('FORBIDDEN');
      expect(payload.error.message).toContain('evil.example.com');
    });

    it('refuses a cross-origin POST with 403 and takes no snapshot', async () => {
      const before = await totalSnapshots();

      const response = await sendJson('POST', '/api/snapshots', { label: 'from-evil' }, [
        'Origin: https://evil.example.com',
      ]);

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
      expect(await totalSnapshots()).toBe(before);
    });

    it('refuses an Origin on loopback but a different port with 403', async () => {
      const otherPort = srv().port === 1 ? 2 : srv().port - 1;
      const response = await get('/api/status', [`Origin: http://127.0.0.1:${otherPort}`]);

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
    });

    it('refuses a cross-origin request for the token-bearing UI shell with 403', async () => {
      const response = await rawRequest(srv().port, [
        ...baseLines('GET', '/'),
        'Origin: https://evil.example.com',
      ]);

      expect(response.status).toBe(403);
      expect(response.body).not.toContain('window.__TIMELOOM__');
      expect(response.body).not.toContain(srv().token);
    });

    it('refuses a malformed Origin header with 403', async () => {
      const response = await get('/api/status', ['Origin: not a url']);

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.message).toContain('Origin');
    });

    it('accepts a same-origin request whose Origin exactly matches the Host', async () => {
      const response = await get('/api/status', [`Origin: http://127.0.0.1:${srv().port}`]);

      expect(response.status).toBe(200);
    });

    it('never emits CORS headers on a successful response', async () => {
      const response = await get('/api/status');

      expect(response.status).toBe(200);
      // Their absence is what stops a cross-origin page reading any reply.
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(response.headers.has('access-control-allow-credentials')).toBe(false);
      expect(response.headers.has('access-control-allow-methods')).toBe(false);
      expect(response.headers.has('access-control-allow-headers')).toBe(false);
      expect(response.headers.has('access-control-expose-headers')).toBe(false);
    });

    it('never emits CORS headers on a refused cross-origin response either', async () => {
      const response = await get('/api/status', ['Origin: https://evil.example.com']);

      expect(response.status).toBe(403);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
      expect(response.headers.has('access-control-allow-credentials')).toBe(false);
    });

    it('does not answer a CORS preflight, so no cross-origin mutation can proceed', async () => {
      const response = await rawRequest(srv().port, [
        ...baseLines('OPTIONS', '/api/snapshots'),
        'Origin: https://evil.example.com',
        'Access-Control-Request-Method: POST',
        'Access-Control-Request-Headers: content-type',
      ]);

      expect(response.status).not.toBe(200);
      expect(response.status).not.toBe(204);
      expect(response.headers.has('access-control-allow-origin')).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Content type gate + security headers
  // ---------------------------------------------------------------------------

  describe('request hardening', () => {
    it('refuses a mutating request without a JSON content type with 415', async () => {
      const before = await totalSnapshots();
      const body = JSON.stringify({ label: 'sneaky' });

      const response = await rawRequest(
        srv().port,
        [
          ...baseLines('POST', '/api/snapshots'),
          `X-Timeloom-Token: ${srv().token}`,
          'Content-Type: text/plain;charset=UTF-8',
          `Content-Length: ${Buffer.byteLength(body)}`,
        ],
        body,
      );

      expect(response.status).toBe(415);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
      expect(await totalSnapshots()).toBe(before);
    });

    it('refuses a form-encoded mutating request with 415', async () => {
      const body = 'label=sneaky';
      const response = await rawRequest(
        srv().port,
        [
          ...baseLines('POST', '/api/snapshots'),
          `X-Timeloom-Token: ${srv().token}`,
          'Content-Type: application/x-www-form-urlencoded',
          `Content-Length: ${Buffer.byteLength(body)}`,
        ],
        body,
      );

      expect(response.status).toBe(415);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    });

    it('checks the token before the content type, so 415 never leaks reachability', async () => {
      const response = await rawRequest(srv().port, [
        ...baseLines('POST', '/api/snapshots'),
        'Content-Type: text/plain',
        'Content-Length: 0',
      ]);

      expect(response.status).toBe(401);
    });

    it('sends X-Content-Type-Options: nosniff on a successful response', async () => {
      const response = await get('/api/status');

      expect(response.status).toBe(200);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
      expect(response.headers.get('cache-control')).toBe('no-store');
    });

    it('sends X-Content-Type-Options: nosniff on a refused response too', async () => {
      const response = await rawRequest(srv().port, baseLines('GET', '/api/status'));

      expect(response.status).toBe(401);
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });

    it('refuses a request body over the 64 KiB cap with a documented IO error', async () => {
      const body = JSON.stringify({ label: 'x'.repeat(70 * 1024) });
      const response = await sendJson('POST', '/api/snapshots', JSON.parse(body));

      expect(response.status).toBe(500);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('IO');
      expect(payload.error.message).toContain('too large');
    });

    it('reports a body that is not valid JSON as an IO error rather than crashing', async () => {
      const body = '{not json at all';
      const response = await rawRequest(
        srv().port,
        [
          ...baseLines('POST', '/api/snapshots'),
          `X-Timeloom-Token: ${srv().token}`,
          'Content-Type: application/json',
          `Content-Length: ${Buffer.byteLength(body)}`,
        ],
        body,
      );

      expect(bodyOf<ApiError>(response).error.code).toBe('IO');
      // The server must still be answering afterwards.
      expect((await get('/api/status')).status).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  // Static serving and path traversal
  // ---------------------------------------------------------------------------

  describe('static file serving', () => {
    const TRAVERSALS = [
      '/..%5c..%5cpackage.json',
      '/%2e%2e/%2e%2e/package.json',
      '/a%2f..%2f..%2fpackage.json',
    ] as const;

    it('refuses /..%5c..%5cpackage.json with 403', async () => {
      const response = await get('/..%5c..%5cpackage.json');

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
      expect(response.body).not.toContain(SENTINEL);
    });

    // Regression test. This used to return 200 (the SPA shell) rather than 403:
    // `serveStatic` was handed `url.pathname` as its "raw" target, but the WHATWG URL
    // parser has already treated `%2e%2e` as a double-dot segment and removed it —
    // `new URL('/%2e%2e/%2e%2e/package.json', base).pathname` is `/package.json` — so
    // the ENCODED_SEPARATOR guard never saw the encoding it exists to reject. `handle`
    // now splits `request.url` itself and passes that as `rawTarget`, so the guard
    // inspects the genuinely undecoded target its comment claims.
    it('refuses /%2e%2e/%2e%2e/package.json with 403', async () => {
      const response = await get('/%2e%2e/%2e%2e/package.json');

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
      expect(response.body).not.toContain(SENTINEL);
    });

    it('refuses /a%2f..%2f..%2fpackage.json with 403', async () => {
      const response = await get('/a%2f..%2f..%2fpackage.json');

      expect(response.status).toBe(403);
      expect(bodyOf<ApiError>(response).error.code).toBe('FORBIDDEN');
      expect(response.body).not.toContain(SENTINEL);
    });

    it('never serves a file outside the UI directory for any encoded-traversal target', async () => {
      // Prove the bait is real: the same bytes are readable from disk one and two
      // levels above the served directory.
      expect(await fs.readFile(path.join(packageDir, 'package.json'), 'utf8')).toBe(SENTINEL);
      expect(await fs.readFile(path.join(tempRoot, 'package.json'), 'utf8')).toBe(SENTINEL);

      for (const target of TRAVERSALS) {
        const response = await get(target);
        expect(response.body, `body for ${target}`).not.toContain(SENTINEL);
        expect(response.status, `status for ${target}`).not.toBe(500);
      }
    });

    it('refuses a plain ../ escape that resolves outside the UI directory with 403', async () => {
      // Sent as a literal segment the URL parser will not collapse, using a backslash
      // (a separator on Windows) so `path.resolve` is the control under test.
      const response = await get('/sub/..%5c..%5c..%5cpackage.json');

      expect(response.status).toBe(403);
      expect(response.body).not.toContain(SENTINEL);
    });

    it('serves the placeholder shell with the session token injected when no UI is installed', async () => {
      const response = await get('/');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.body).toContain('timeloom is running');
      expect(response.body).toContain(
        `window.__TIMELOOM__=${JSON.stringify({ token: srv().token })}`,
      );
    });

    it('injects the session token into a real index.html before the closing head tag', async () => {
      await fs.writeFile(
        path.join(uiDir, 'index.html'),
        '<!doctype html><html><head><title>ui</title></head><body>real ui</body></html>',
        'utf8',
      );

      const response = await get('/');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.body).toContain('real ui');
      expect(response.body).toContain(
        `window.__TIMELOOM__=${JSON.stringify({ token: srv().token })}`,
      );
      expect(response.body.indexOf('window.__TIMELOOM__')).toBeLessThan(
        response.body.indexOf('</head>'),
      );
    });

    // BUG: an unknown extensionless path falls back to index.html's bytes but takes
    // the wrong branch on the way out. `extension` is '' for `/dashboard` and
    // `relative` is 'dashboard', so `extension === '.html' || relative === 'index.html'`
    // is false: the shell is sent as `application/octet-stream` and, critically,
    // `injectToken` is never applied. Combined with the `nosniff` header the browser
    // downloads the file instead of rendering it, and even if it did render, the page
    // would have no `window.__TIMELOOM__.token` and could not call the API. Every
    // client-side route in the UI (a deep link, or a reload on any page but `/`) hits
    // this. Expected: content-type `text/html; charset=utf-8` with the token injected.
    // Note the placeholder path masks it — the bug only appears once a real
    // `ui/index.html` exists.
    it('serves the injected shell for an unknown client-side route', async () => {
      await fs.writeFile(
        path.join(uiDir, 'index.html'),
        '<!doctype html><html><head><title>ui</title></head><body>real ui</body></html>',
        'utf8',
      );

      const response = await get('/snapshots/abc123');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(response.body).toContain(
        `window.__TIMELOOM__=${JSON.stringify({ token: srv().token })}`,
      );
    });

    it('serves a static asset with the mime type its extension implies', async () => {
      await fs.writeFile(path.join(uiDir, 'app.css'), 'body{color:red}', 'utf8');

      const response = await get('/app.css');

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/css; charset=utf-8');
      expect(response.body).toBe('body{color:red}');
    });

    it('survives a malformed percent-escape in the request target and keeps serving', async () => {
      const response = await get('/%zz');

      expect(response.body.length).toBeGreaterThan(0);
      const payload = bodyOf<ApiError>(response);
      expect(typeof payload.error.code).toBe('string');
      expect(typeof payload.error.message).toBe('string');
      expect((await get('/api/status')).status).toBe(200);
    });

    // BUG: a malformed percent-escape is a client error but produces
    // `500 INTERNAL {"error":{"code":"INTERNAL","message":"URI malformed"}}`.
    // `handle` calls `decodeURIComponent(url.pathname)` at the very top, before any
    // check; `decodeURIComponent('/%zz')` throws a URIError, which falls through to
    // the generic 500 handler in the `createServer` callback. Expected: 400 with a
    // client-error code, the way the other bad-input paths behave. Low severity — the
    // process survives and nothing is leaked — but a 5xx here misattributes the fault.
    it('reports a malformed percent-escape in the request target as 400', async () => {
      const response = await get('/%zz');

      expect(response.status).toBe(400);
      expect(bodyOf<ApiError>(response).error.code).not.toBe('INTERNAL');
    });
  });

  // ---------------------------------------------------------------------------
  // Functional endpoints
  // ---------------------------------------------------------------------------

  describe('GET /api/status', () => {
    it('returns the documented ApiStatus shape with pre-formatted display fields', async () => {
      const response = await get('/api/status');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');

      const status = bodyOf<ApiStatus>(response);

      expect(status.root).toBe(path.resolve(projectRoot));
      expect(status.projectName).toBe(path.basename(projectRoot));
      expect(status.snapshotCount).toBe(1);
      expect(status.watching).toBe(false);
      expect(status.watchMode).toBeNull();
      expect(status.language).toBe('en');
      expect(status.version).toBe('9.9.9-test');
      expect(status.health).toEqual({ enabled: false, command: null });
      expect(status.objectCount).toBeGreaterThan(0);
      expect(status.storeBytes).toBeGreaterThan(0);
      // Nothing has been touched since init, so the working tree matches the snapshot.
      expect(status.pendingChanges).toEqual({ added: 0, modified: 0, deleted: 0 });
      expect(status.lastHealthy).toBeNull();

      // The formatted fields the UI renders verbatim.
      expect(status.storeBytesHuman).toMatch(/^\d+(\.\d)? (B|KiB|MiB|GiB|TiB)$/);

      const latest = status.latest;
      expect(latest).not.toBeNull();
      expect(latest!.id).toBe(repo().latest()!.id);
      expect(latest!.trigger).toBe('init');
      expect(latest!.triggerLabel).toBe('initial');
      expect(latest!.createdAtRelative).toMatch(/^(just now|\d+ min ago)$/);
      expect(latest!.summaryText.length).toBeGreaterThan(0);
      expect(latest!.summaryText).toContain('3 files');
      expect(latest!.totalBytesHuman).toMatch(/^\d+(\.\d)? (B|KiB|MiB|GiB|TiB)$/);
      expect(latest!.counts).toEqual({ added: 3, modified: 0, deleted: 0 });
      expect(latest!.fileCount).toBe(3);
      expect(latest!.health).toBeNull();
    });

    it('reports pending changes once the working tree drifts from the latest snapshot', async () => {
      await fs.writeFile(
        path.join(projectRoot, 'index.js'),
        'console.log("edited now");\n',
        'utf8',
      );
      await fs.writeFile(path.join(projectRoot, 'brand-new.txt'), 'hello\n', 'utf8');

      const status = bodyOf<ApiStatus>(await get('/api/status'));

      expect(status.pendingChanges).toEqual({ added: 1, modified: 1, deleted: 0 });
    });
  });

  describe('GET /api/snapshots', () => {
    async function seedThreeMore(): Promise<void> {
      for (const label of ['alpha', 'beta', 'gamma']) {
        await repo().snapshot({ trigger: 'manual', label, force: true });
      }
    }

    it('lists snapshots newest first and reports the true total', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots'));

      expect(list.total).toBe(4);
      expect(list.snapshots).toHaveLength(4);
      expect(list.snapshots.map((s) => s.label)).toEqual(['gamma', 'beta', 'alpha', null]);
    });

    it('honours limit while still reporting the true total', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots?limit=2'));

      expect(list.snapshots.map((s) => s.label)).toEqual(['gamma', 'beta']);
      expect(list.total).toBe(4);
    });

    it('honours offset alongside limit', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots?limit=2&offset=1'));

      expect(list.snapshots.map((s) => s.label)).toEqual(['beta', 'alpha']);
      expect(list.total).toBe(4);
    });

    it('returns an empty page past the end without changing the total', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots?offset=99'));

      expect(list.snapshots).toEqual([]);
      expect(list.total).toBe(4);
    });

    it('falls back to the default page size when limit is not a number', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots?limit=not-a-number'));

      expect(list.snapshots).toHaveLength(4);
      expect(list.total).toBe(4);
    });

    it('clamps a limit below the minimum to one snapshot', async () => {
      await seedThreeMore();

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots?limit=0'));

      expect(list.snapshots).toHaveLength(1);
      expect(list.total).toBe(4);
    });
  });

  describe('POST /api/snapshots', () => {
    it('creates a labelled snapshot and returns 201 with the created record', async () => {
      const response = await sendJson('POST', '/api/snapshots', { label: 'before refactor' });

      expect(response.status).toBe(201);
      const payload = bodyOf<CreateSnapshotResponse>(response);
      expect(payload.unchanged).toBe(false);
      expect(payload.snapshot).not.toBeNull();
      expect(payload.snapshot!.label).toBe('before refactor');
      expect(payload.snapshot!.trigger).toBe('manual');
      expect(payload.snapshot!.triggerLabel).toBe('manual');

      expect(await totalSnapshots()).toBe(2);
      expect(repo().get(payload.snapshot!.id)?.label).toBe('before refactor');
    });

    it('reports unchanged and records nothing when the tree is byte-identical', async () => {
      const response = await sendJson('POST', '/api/snapshots', {});

      expect(response.status).toBe(201);
      const payload = bodyOf<CreateSnapshotResponse>(response);
      expect(payload.unchanged).toBe(true);
      expect(payload.snapshot).toBeNull();
      expect(await totalSnapshots()).toBe(1);
    });

    it('captures a real edit when no label is given', async () => {
      await fs.writeFile(path.join(projectRoot, 'index.js'), 'console.log("second");\n', 'utf8');

      const payload = bodyOf<CreateSnapshotResponse>(await sendJson('POST', '/api/snapshots', {}));

      expect(payload.unchanged).toBe(false);
      expect(payload.snapshot).not.toBeNull();
      expect(payload.snapshot!.label).toBeNull();
      expect(payload.snapshot!.counts).toEqual({ added: 0, modified: 1, deleted: 0 });
    });
  });

  describe('PATCH /api/snapshots/:id', () => {
    it('sets a label and the pinned flag, and the change survives a re-read', async () => {
      const id = repo().latest()!.id;

      const response = await sendJson('PATCH', `/api/snapshots/${id}`, {
        label: 'keep me',
        pinned: true,
      });

      expect(response.status).toBe(200);
      const payload = bodyOf<PatchSnapshotResponse>(response);
      expect(payload.snapshot.id).toBe(id);
      expect(payload.snapshot.label).toBe('keep me');
      expect(payload.snapshot.pinned).toBe(true);

      const list = bodyOf<ApiSnapshotList>(await get('/api/snapshots'));
      expect(list.snapshots[0]?.label).toBe('keep me');
      expect(list.snapshots[0]?.pinned).toBe(true);
    });

    it('clears a label when null is sent explicitly', async () => {
      const id = repo().latest()!.id;
      await sendJson('PATCH', `/api/snapshots/${id}`, { label: 'temporary' });

      const payload = bodyOf<PatchSnapshotResponse>(
        await sendJson('PATCH', `/api/snapshots/${id}`, { label: null }),
      );

      expect(payload.snapshot.label).toBeNull();
    });

    it('leaves untouched fields alone when the patch omits them', async () => {
      const id = repo().latest()!.id;
      await sendJson('PATCH', `/api/snapshots/${id}`, { label: 'stable', pinned: true });

      const payload = bodyOf<PatchSnapshotResponse>(
        await sendJson('PATCH', `/api/snapshots/${id}`, { pinned: false }),
      );

      expect(payload.snapshot.label).toBe('stable');
      expect(payload.snapshot.pinned).toBe(false);
    });
  });

  describe('GET /api/snapshots/:id', () => {
    it('returns the snapshot with its diff against the parent', async () => {
      await fs.writeFile(path.join(projectRoot, 'index.js'), 'console.log("v2 longer");\n', 'utf8');
      const created = await repo().snapshot({ trigger: 'manual', label: null, force: false });
      const id = created.snapshot!.id;

      const detail = bodyOf<ApiSnapshotDetail>(await get(`/api/snapshots/${id}`));

      expect(detail.snapshot.id).toBe(id);
      expect(detail.changes.map((c) => [c.path, c.status])).toEqual([['index.js', 'modified']]);
    });

    it('answers 404 with the documented error envelope for an unknown id', async () => {
      const response = await get('/api/snapshots/deadbeefdeadbeef');

      expect(response.status).toBe(404);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('SNAPSHOT_NOT_FOUND');
      expect(payload.error.message).toContain('deadbeefdeadbeef');
    });

    it('answers 409 when a reference matches more than one snapshot', async () => {
      const first = repo().latest()!.id;
      const second = (await repo().snapshot({ trigger: 'manual', label: null, force: true }))
        .snapshot!.id;
      await repo().update(first, { label: 'dup' });
      await repo().update(second, { label: 'dup' });

      const response = await get('/api/snapshots/dup');

      expect(response.status).toBe(409);
      expect(bodyOf<ApiError>(response).error.code).toBe('AMBIGUOUS_ID');
    });
  });

  describe('GET /api/snapshots/:id/content', () => {
    it('returns the exact text of a text file, round-tripped through the store', async () => {
      const id = repo().latest()!.id;

      const response = await get(
        `/api/snapshots/${id}/content?path=${encodeURIComponent('index.js')}`,
      );

      expect(response.status).toBe(200);
      const payload = bodyOf<ApiFileContent>(response);
      expect(payload.path).toBe('index.js');
      expect(payload.text).toBe('console.log("hello");\n');
      expect(payload.size).toBe(Buffer.byteLength('console.log("hello");\n'));
      expect(payload.truncated).toBe(false);
    });

    it('returns text: null for content containing a NUL byte', async () => {
      const id = repo().latest()!.id;

      const response = await get(
        `/api/snapshots/${id}/content?path=${encodeURIComponent('data.bin')}`,
      );

      expect(response.status).toBe(200);
      const payload = bodyOf<ApiFileContent>(response);
      expect(payload.path).toBe('data.bin');
      expect(payload.text).toBeNull();
      expect(payload.size).toBe(6);
      expect(payload.truncated).toBe(false);
    });

    it('resolves a nested POSIX path inside the snapshot', async () => {
      const id = repo().latest()!.id;

      const payload = bodyOf<ApiFileContent>(
        await get(`/api/snapshots/${id}/content?path=${encodeURIComponent('src/app.ts')}`),
      );

      expect(payload.path).toBe('src/app.ts');
      expect(payload.text).toBe('export const app = 1;\n');
    });

    it('answers 404 for a path that is not in that snapshot', async () => {
      const id = repo().latest()!.id;

      const response = await get(
        `/api/snapshots/${id}/content?path=${encodeURIComponent('nope/missing.txt')}`,
      );

      expect(response.status).toBe(404);
      const payload = bodyOf<ApiError>(response);
      expect(payload.error.code).toBe('SNAPSHOT_NOT_FOUND');
      expect(payload.error.message).toContain('nope/missing.txt');
    });

    it('answers 400 when the path query parameter is missing', async () => {
      const id = repo().latest()!.id;

      const response = await get(`/api/snapshots/${id}/content`);

      expect(response.status).toBe(400);
      expect(bodyOf<ApiError>(response).error.code).toBe('BAD_REQUEST');
    });

    it('refuses to read a file the snapshot never contained, however the path is spelled', async () => {
      const id = repo().latest()!.id;

      // The content endpoint is a lookup in the recorded tree, not a filesystem read,
      // so an absolute or traversing path simply is not a member of the tree.
      for (const wanted of ['../../package.json', '..\\..\\package.json', '/etc/passwd']) {
        const response = await get(
          `/api/snapshots/${id}/content?path=${encodeURIComponent(wanted)}`,
        );
        expect(response.status, `status for ${wanted}`).toBe(404);
        expect(response.body, `body for ${wanted}`).not.toContain(SENTINEL);
      }
    });
  });

  describe('GET /api/snapshots/:id/restore-preview', () => {
    it('lists everything a restore would write and delete without touching the tree', async () => {
      const targetId = repo().latest()!.id;

      await fs.writeFile(
        path.join(projectRoot, 'index.js'),
        'console.log("locally edited, much longer than before");\n',
        'utf8',
      );
      await fs.writeFile(
        path.join(projectRoot, 'extra.txt'),
        'created after the snapshot\n',
        'utf8',
      );
      await fs.rm(path.join(projectRoot, 'src', 'app.ts'));

      const response = await get(`/api/snapshots/${targetId}/restore-preview`);
      expect(response.status).toBe(200);

      const preview = bodyOf<ApiRestorePreview>(response);
      expect(preview.targetId).toBe(targetId);
      expect(preview.willWrite.map((c) => [c.path, c.status])).toEqual([
        ['index.js', 'modified'],
        ['src/app.ts', 'added'],
      ]);
      expect(preview.willDelete.map((c) => [c.path, c.status])).toEqual([['extra.txt', 'deleted']]);

      // The preview is a plan, not an action: the tree is exactly as we left it.
      expect(await fs.readFile(path.join(projectRoot, 'index.js'), 'utf8')).toBe(
        'console.log("locally edited, much longer than before");\n',
      );
      expect(await fs.readFile(path.join(projectRoot, 'extra.txt'), 'utf8')).toBe(
        'created after the snapshot\n',
      );
      await expect(fs.access(path.join(projectRoot, 'src', 'app.ts'))).rejects.toThrow();
      expect(await totalSnapshots()).toBe(1);
    });

    it('reports an empty plan when the tree already matches the snapshot', async () => {
      const targetId = repo().latest()!.id;

      const preview = bodyOf<ApiRestorePreview>(
        await get(`/api/snapshots/${targetId}/restore-preview`),
      );

      expect(preview.willWrite).toEqual([]);
      expect(preview.willDelete).toEqual([]);
    });
  });

  describe('routing and error envelopes', () => {
    it('answers an unknown route with 404 and the documented error envelope', async () => {
      const response = await get('/api/does-not-exist');

      expect(response.status).toBe(404);
      const payload = bodyOf<ApiError>(response);
      expect(payload).toEqual({
        error: {
          code: 'NOT_FOUND',
          message: 'No route for GET /api/does-not-exist',
          hint: null,
        },
      });
    });

    it('answers a known path with the wrong method with 404 rather than acting on it', async () => {
      const before = await totalSnapshots();

      const response = await sendJson('POST', '/api/status', {});

      expect(response.status).toBe(404);
      expect(bodyOf<ApiError>(response).error.code).toBe('NOT_FOUND');
      expect(await totalSnapshots()).toBe(before);
    });
  });

  describe('GET /api/events', () => {
    it('streams engine events broadcast after the stream is opened', async () => {
      const socket = net.connect({ port: srv().port, host: '127.0.0.1' });
      openSockets.push(socket);

      let received = '';
      socket.on('data', (chunk: Buffer) => {
        received += chunk.toString('utf8');
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      socket.write(
        [
          `GET /api/events?token=${srv().token} HTTP/1.1`,
          `Host: 127.0.0.1:${srv().port}`,
          'Accept: text/event-stream',
          '',
          '',
        ].join('\r\n'),
      );

      await waitFor(() => received.includes(': connected'), 'the stream to open');
      expect(received.split('\r\n\r\n')[0]).toContain('text/event-stream');

      srv().broadcast({ type: 'watch-status', watching: true, pendingPaths: 7 });

      await waitFor(() => received.includes('watch-status'), 'the broadcast event');
      expect(received).toContain('"pendingPaths":7');

      socket.destroy();
    });

    it('refuses to open a stream without a valid token', async () => {
      const response = await rawRequest(srv().port, baseLines('GET', '/api/events'));

      expect(response.status).toBe(401);
      expect(bodyOf<ApiError>(response).error.code).toBe('UNAUTHORIZED');
    });
  });

  describe('binding', () => {
    it('refuses to start on a non-loopback host', async () => {
      await expect(
        startServer({
          repository: repo(),
          session: null,
          logger: silentLogger,
          host: '0.0.0.0',
          port: 0,
          version: '9.9.9-test',
          uiDir,
        }),
      ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    });

    it('mints a fresh token per run and reports it in the printed url', async () => {
      const second = await startServer({
        repository: repo(),
        session: null,
        logger: silentLogger,
        host: '127.0.0.1',
        port: 0,
        version: '9.9.9-test',
        uiDir,
      });

      try {
        expect(second.token).not.toBe(srv().token);
        expect(second.port).toBeGreaterThan(0);
        expect(second.url).toBe(`http://127.0.0.1:${second.port}/?token=${second.token}`);
      } finally {
        await second.close();
      }
    });
  });
});
