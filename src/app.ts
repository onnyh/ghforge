/**
 * app.ts — the HTTP server: one listener routing the four surfaces (git
 * smart HTTP, REST v3, GraphQL, MCP) plus the unauthenticated /healthz the
 * suite probes at boot.
 *
 * Cross-cutting rules live here so no surface can forget them: the bearer
 * token is required everywhere except /healthz (a miss is a JSON 401), every
 * API reply is application/json with a non-empty X-GitHub-Request-Id, an
 * unknown route is a JSON 404, and a malformed JSON body is a 400.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { infoRefs, receivePack, uploadPack } from './gitproto.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type ApiRequest } from './rest.ts';
import { HttpError, type Forge } from './store.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `ghforge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(bytes.length),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(bytes);
}

function sendError(res: ServerResponse, err: unknown): void {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { message: err.message });
    return;
  }
  console.error('unhandled error:', err);
  sendJson(res, 500, { message: 'Internal Server Error' });
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(forge: Forge, token: string): Server {
  const authorized = (req: IncomingMessage): boolean => {
    if (token === '') return true;
    return req.headers.authorization === `Bearer ${token}`;
  };

  const server = createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://ghforge.internal');
        const segments = url.pathname.split('/').filter((part) => part !== '').map(decodeSegment);
        const method = req.method ?? 'GET';

        if (segments.length === 1 && segments[0] === 'healthz' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const rawBody = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

        // ---------------------------------------------------------- REST v3
        if (segments[0] === 'api' && segments[1] === 'v3') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          let body: Record<string, unknown> | undefined;
          if (rawBody.length > 0) {
            try {
              const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
              body = parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' });
              return;
            }
          }
          const host = req.headers.host ?? 'localhost';
          const apiReq: ApiRequest = {
            method,
            path: segments.slice(2),
            query: url.searchParams,
            body,
            origin: `http://${host}`,
          };
          const apiReply = handleRest(forge, apiReq);
          if (apiReply.status === 204 || apiReply.body === undefined) {
            res.writeHead(apiReply.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, apiReply.status, apiReply.body, apiReply.headers ?? {});
          return;
        }

        // ---------------------------------------------------------- GraphQL
        if (segments[0] === 'api' && segments[1] === 'graphql') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            sendJson(res, 400, { errors: [{ message: 'invalid JSON in request body' }] });
            return;
          }
          const result = handleGraphQL(forge, parsed);
          sendJson(res, result.status, result.body);
          return;
        }

        // ---------------------------------------------------------- MCP
        if (segments[0] === 'mcp') {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          let parsed: unknown;
          let parseError = false;
          try {
            parsed = JSON.parse(rawBody.toString('utf8'));
          } catch {
            parseError = true;
          }
          const mcpReply = handleMcp(forge, parsed, parseError);
          if (mcpReply.body === undefined) {
            res.writeHead(mcpReply.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, mcpReply.status, mcpReply.body);
          return;
        }

        // ---------------------------------------------------------- git smart HTTP
        if (segments.length >= 2 && segments[1].endsWith('.git')) {
          if (!authorized(req)) {
            sendJson(res, 401, { message: 'Bad credentials' });
            return;
          }
          const owner = segments[0];
          const name = segments[1].slice(0, -'.git'.length);
          const repo = forge.getRepo(owner, name);
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const rest = segments.slice(2);
          const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
          if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
            const gitReply = infoRefs(forge, repo, url.searchParams.get('service') ?? '', wantsV2);
            res.writeHead(gitReply.status, { 'content-type': gitReply.contentType, 'content-length': String(gitReply.body.length) });
            res.end(gitReply.body);
            return;
          }
          if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
            const gitReply = uploadPack(forge, repo, rawBody, wantsV2);
            res.writeHead(gitReply.status, { 'content-type': gitReply.contentType, 'content-length': String(gitReply.body.length) });
            res.end(gitReply.body);
            return;
          }
          if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
            const gitReply = receivePack(forge, repo, rawBody);
            res.writeHead(gitReply.status, { 'content-type': gitReply.contentType, 'content-length': String(gitReply.body.length) });
            res.end(gitReply.body);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        sendError(res, err);
      }
    })();
  });
  return server;
}
