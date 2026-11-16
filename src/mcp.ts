/**
 * mcp.ts — the Model Context Protocol endpoint at /mcp: JSON-RPC 2.0 over
 * the streamable HTTP transport, speaking the 2026-07-28 revision through
 * server/discover (and the older initialize handshake for clients that ask).
 *
 * The six tools act on the same store as REST, through the same record
 * operations, so an object created here reads back over /api/v3 unchanged.
 * The tool list is a constant: two tools/list calls answer byte for byte.
 */

import { createIssue, createPull, mergePull } from './records.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';
import { HttpError, type Forge } from './store.ts';

const SERVER_INFO = { name: 'ghforge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, inputSchema: { type: 'object', properties, additionalProperties: false, required } };
}

const str = (description: string): Record<string, unknown> => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  tool(
    'create_repo',
    'Create a new repository owned by the authenticated user.',
    { name: str('The repository name'), description: str('A short description of the repository'), private: { type: 'boolean', description: 'Whether the repository is private' } },
    ['name'],
  ),
  tool(
    'get_repo',
    'Read one repository by owner and name.',
    { owner: str('The repository owner login'), repo: str('The repository name') },
    ['owner', 'repo'],
  ),
  tool(
    'create_issue',
    'Open an issue in a repository.',
    { owner: str('The repository owner login'), repo: str('The repository name'), title: str('The issue title'), body: str('The issue body') },
    ['owner', 'repo', 'title'],
  ),
  tool(
    'list_issues',
    'List the issues of a repository, optionally filtered by state (open, closed or all).',
    { owner: str('The repository owner login'), repo: str('The repository name'), state: str('The issue state filter: open, closed or all') },
    ['owner', 'repo'],
  ),
  tool(
    'create_pull_request',
    'Open a pull request from a head branch into a base branch.',
    {
      owner: str('The repository owner login'),
      repo: str('The repository name'),
      title: str('The pull request title'),
      body: str('The pull request body'),
      head: str('The head branch to merge from'),
      base: str('The base branch to merge into'),
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  tool(
    'merge_pull_request',
    'Merge an open pull request into its base branch.',
    { owner: str('The repository owner login'), repo: str('The repository name'), pull_number: { type: 'integer', description: 'The pull request number' } },
    ['owner', 'repo', 'pull_number'],
  ),
];

// ------------------------------------------------------------ tool calls

interface ToolOutcome {
  payload: unknown;
  isError: boolean;
}

function ok(payload: unknown): ToolOutcome {
  return { payload, isError: false };
}

function failure(message: string): ToolOutcome {
  return { payload: message, isError: true };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome | 'unknown' | { missing: string } {
  const def = TOOLS.find((entry) => entry.name === name);
  if (def === undefined) return 'unknown';
  const required = (def.inputSchema.required as string[]) ?? [];
  for (const property of required) {
    if (args[property] === undefined || args[property] === null || args[property] === '') return { missing: property };
  }
  try {
    switch (name) {
      case 'create_repo': {
        const repo = forge.createRepo({
          name: String(args.name),
          description: typeof args.description === 'string' ? args.description : undefined,
          private: args.private === true,
        });
        return ok(repoJson(repo));
      }
      case 'get_repo': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return failure(`repository ${String(args.owner)}/${String(args.repo)} not found`);
        return ok(repoJson(repo));
      }
      case 'create_issue': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return failure('repository not found');
        const issue = createIssue(forge, repo, { title: args.title, body: args.body });
        return ok(issueJson(repo, issue));
      }
      case 'list_issues': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return failure('repository not found');
        const state = typeof args.state === 'string' ? args.state : 'open';
        let issues = [...repo.issues.values()].sort((a, b) => a.seq - b.seq);
        if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
        else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
        return ok(issues.map((issue) => issueJson(repo, issue)));
      }
      case 'create_pull_request': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return failure('repository not found');
        const pull = createPull(forge, repo, { title: args.title, body: args.body, head: args.head, base: args.base });
        return ok(pullJson(forge, repo, pull));
      }
      case 'merge_pull_request': {
        const repo = forge.getRepo(String(args.owner ?? ''), String(args.repo ?? ''));
        if (repo === undefined) return failure('repository not found');
        const pull = repo.pulls.get(Number(args.pull_number));
        if (pull === undefined) return failure(`pull request ${String(args.pull_number)} not found`);
        mergePull(forge, repo, pull, 'merge');
        return ok(pullJson(forge, repo, pull));
      }
      default:
        return 'unknown';
    }
  } catch (err) {
    if (err instanceof HttpError) return failure(err.message);
    return failure(err instanceof Error ? err.message : 'tool call failed');
  }
}

// ------------------------------------------------------------ JSON-RPC

export interface McpReply {
  status: number;
  /** The JSON-RPC response object; undefined means "answer with no body" (a notification). */
  body?: unknown;
}

function rpcResult(id: unknown, result: unknown): McpReply {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, status: number, code: number, message: string): McpReply {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function discoverResult(): Record<string, unknown> {
  return {
    supportedVersions: SUPPORTED_VERSIONS,
    capabilities: { tools: {} },
    serverInfo: SERVER_INFO,
    _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
  };
}

function handleOne(forge: Forge, message: Record<string, unknown>): McpReply {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = message.id;
  const isNotification = id === undefined;
  const params = (message.params ?? {}) as Record<string, unknown>;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, discoverResult());
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      if (outcome === 'unknown') return rpcError(id, 200, -32601, `tool not found: ${toolName}`);
      if ('missing' in outcome) return rpcError(id, 200, -32602, `missing required argument: ${outcome.missing}`);
      const text = typeof outcome.payload === 'string' ? outcome.payload : JSON.stringify(outcome.payload);
      const result: Record<string, unknown> = { content: [{ type: 'text', text }], isError: outcome.isError };
      if (!outcome.isError && typeof outcome.payload === 'object' && outcome.payload !== null) {
        result.structuredContent = outcome.payload;
      }
      return rpcResult(id, result);
    }
    case 'resources/list':
      return rpcResult(id, { resources: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      if (isNotification) return { status: 202 };
      return rpcError(id, 200, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body. `parseError` is true when the body was not JSON
 * at all: the answer is HTTP 400 with a -32700 parse error, per the transport.
 */
export function handleMcp(forge: Forge, body: unknown, parseError: boolean): McpReply {
  if (parseError) return rpcError(null, 400, -32700, 'Parse error: the request body is not valid JSON');
  if (Array.isArray(body)) {
    const replies: unknown[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== 'object') continue;
      const reply = handleOne(forge, entry as Record<string, unknown>);
      if (reply.body !== undefined) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  if (body === null || typeof body !== 'object') return rpcError(null, 400, -32600, 'Invalid request');
  const message = body as Record<string, unknown>;
  if (message.id === undefined && typeof message.method === 'string') {
    // A notification: accepted, answered with no body.
    handleOne(forge, message);
    return { status: 202 };
  }
  return handleOne(forge, message);
}
