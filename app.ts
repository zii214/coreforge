// The HTTP server: one process serving git smart HTTP at /{owner}/{repo}.git, REST v3 under
// /api/v3, GraphQL at /api/graphql and MCP at /mcp, all over the single Forge store in lib/store.ts.
// Authentication is the trial's bearer token (MAKEFUN_SHOP_TOKEN) on every surface but /healthz: a
// request without it, or with a different one, is a 401. Every reply carries an X-GitHub-Request-Id;
// REST replies are always JSON, including 404s and 400s, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './lib/store.ts';
import { handleRest } from './lib/rest.ts';
import { executeGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';
import { gitInfoRefs, gitReceivePack, gitUploadPack } from './lib/git.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function sendJson(res: ServerResponse, status: number, body: unknown, requestId: string, headers: Record<string, string> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'x-github-request-id': requestId,
    ...(text === '' ? {} : { 'content-length': Buffer.byteLength(text) }),
    ...headers,
  });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer, requestId: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, 'x-github-request-id': requestId });
  res.end(body);
}

/** Read a whole request body (uploads are packs; everything else is small JSON). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** The token the trial hands this process; empty only in local development, where auth is skipped. */
function expectedToken(): string {
  return process.env.MAKEFUN_SHOP_TOKEN ?? '';
}

function authorized(req: IncomingMessage): boolean {
  const token = expectedToken();
  if (token === '') return true;
  return (req.headers.authorization ?? '') === `Bearer ${token}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  let requestCounter = 0;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = requestCounter.toString(16).padStart(8, '0').toUpperCase();
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        if (!authorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestId);
          return;
        }

        // MCP: JSON-RPC over Streamable HTTP. A DELETE closes a session we never opened; answer 200.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {}, requestId);
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'method not allowed' } }, requestId);
            return;
          }
          const body = await readBody(req);
          const reply = handleMcp(forge, body.toString('utf8'));
          if (reply.body === null) {
            res.writeHead(reply.status, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, requestId);
          return;
        }

        // GraphQL: one operation object, or an array of them answered in order.
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'the request body is not JSON' }] }, requestId);
            return;
          }
          if (Array.isArray(parsed)) {
            sendJson(res, 200, parsed.map((operation) => executeGraphQL(forge, (operation ?? {}) as Record<string, unknown>)), requestId);
            return;
          }
          sendJson(res, 200, executeGraphQL(forge, (parsed ?? {}) as Record<string, unknown>), requestId);
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segments = path
            .slice('/api/v3'.length)
            .split('/')
            .filter((segment) => segment !== '')
            .map((segment) => decodeURIComponent(segment));
          let bodyValue: unknown = undefined;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            if (raw.length > 0) {
              try {
                bodyValue = JSON.parse(raw.toString('utf8'));
              } catch {
                sendJson(res, 400, { message: 'Problems parsing JSON' }, requestId);
                return;
              }
            }
          }
          const baseUrl = `http://${req.headers.host ?? 'entry'}`;
          const reply = handleRest(forge, method, segments, url.searchParams, bodyValue, baseUrl);
          if (reply.status === 204) {
            res.writeHead(204, { 'x-github-request-id': requestId });
            res.end();
            return;
          }
          sendJson(res, reply.status, reply.body, requestId, reply.headers ?? {});
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/<action> (info/refs is two segments, the rest one).
        const segments = path.split('/').filter((segment) => segment !== '');
        if (segments.length >= 3 && segments[1]!.endsWith('.git')) {
          const owner = decodeURIComponent(segments[0]!);
          const repoName = decodeURIComponent(segments[1]!.slice(0, -'.git'.length));
          const action = segments.slice(2).join('/');
          if (action === 'info/refs' && method === 'GET') {
            const protocol = req.headers['git-protocol'] ?? '';
            const reply = gitInfoRefs(forge, owner, repoName, url.searchParams.get('service') ?? '', protocol.includes('version=2'));
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          if (action === 'git-upload-pack' && method === 'POST') {
            const reply = gitUploadPack(forge, owner, repoName, await readBody(req));
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
          if (action === 'git-receive-pack' && method === 'POST') {
            const reply = gitReceivePack(forge, owner, repoName, await readBody(req));
            sendBuffer(res, reply.status, reply.contentType, reply.body, requestId);
            return;
          }
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch {
        // A request must never take the process down: answer 500 and keep serving.
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' }, requestId);
        else res.end();
      }
    })();
  });
}
