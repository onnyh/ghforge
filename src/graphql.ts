/**
 * graphql.ts — the GraphQL v4 API at /api/graphql: the queries and mutations
 * gh and github-mcp-server send, over the same store REST serves.
 *
 * A small executor walks the parsed document against a hand-written schema.
 * Global ids are opaque, stable base64url encodings of the object's kind and
 * key (never the bare database id), and node(id:) decodes them back.
 * Introspection answers from the same schema definition, so __type lists
 * exactly the fields the executor serves. An unknown field is a 200 with an
 * errors array naming it; an unknown repository is data.repository = null.
 */

import { parseGraphQL, resolveValue, type GqlOperation, type GqlSelection } from './gqlparse.ts';
import { addComment, createIssue, createPull, mergePull, pullFiles, pullMergeable, type MergeMethod } from './records.ts';
import { VIEWER, type Forge, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { nowIso } from './clock.ts';

// ------------------------------------------------------------ global ids

function gid(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`v1:${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

function parseGid(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    if (!text.startsWith('v1:')) return null;
    const segments = text.slice(3).split(':');
    return { kind: segments[0], parts: segments.slice(1) };
  } catch {
    return null;
  }
}

const repoGid = (repo: RepoRec): string => gid('repo', repo.id);
const issueGid = (repo: RepoRec, issue: IssueRec): string => gid('issue', repo.id, issue.number);
const pullGid = (repo: RepoRec, pull: PullRec): string => gid('pr', repo.id, pull.number);
const commentGid = (repo: RepoRec, number: number, commentId: number): string => gid('comment', repo.id, number, commentId);
const userGid = (): string => gid('user', VIEWER.id);
const cursorFor = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');

function repoById(forge: Forge, id: number): RepoRec | undefined {
  for (const repo of forge.repos.values()) if (repo.id === id) return repo;
  return undefined;
}

// ------------------------------------------------------------ schema types

type Args = Record<string, unknown>;
type Resolver = (forge: Forge, source: any, args: Args) => unknown;

interface FieldDef {
  type: string;
  resolve: Resolver;
}

interface TypeDef {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT';
  fields?: Record<string, FieldDef>;
  enumValues?: string[];
}

const scalar = (pick: (source: any) => unknown): Resolver => (_forge, source) => pick(source);

interface IssueAt {
  repo: RepoRec;
  issue: IssueRec;
}

interface PullAt {
  repo: RepoRec;
  pull: PullRec;
}

function issuesConnection(forge: Forge, repo: RepoRec, args: Args): Record<string, unknown> {
  let list = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : 'closed')));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
  const descending = orderBy.direction === 'DESC';
  list.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  let start = 0;
  if (typeof args.after === 'string' && args.after !== '') {
    try {
      const text = Buffer.from(args.after, 'base64url').toString('utf8');
      const number = Number.parseInt(text.replace(/^cursor:/, ''), 10);
      const index = list.findIndex((issue) => issue.number === number);
      if (index >= 0) start = index + 1;
    } catch {
      start = 0;
    }
  }
  const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
  const slice = list.slice(start, start + first);
  const hasNextPage = start + slice.length < list.length;
  const endCursor = slice.length > 0 ? cursorFor(slice[slice.length - 1].number) : null;
  return { repo, nodes: slice, hasNextPage, endCursor, totalCount: list.length };
}

const SCHEMA: Record<string, TypeDef> = {
  Query: {
    kind: 'OBJECT',
    fields: {
      viewer: { type: 'User', resolve: () => VIEWER },
      repository: {
        type: 'Repository',
        resolve: (forge, _source, args) => forge.getRepo(String(args.owner ?? ''), String(args.name ?? '')) ?? null,
      },
      node: {
        type: 'Node',
        resolve: (forge, _source, args) => {
          const parsed = parseGid(String(args.id ?? ''));
          if (parsed === null) return null;
          if (parsed.kind === 'repo') {
            const repo = repoById(forge, Number(parsed.parts[0]));
            return repo === undefined ? null : { __gqlType: 'Repository', value: repo };
          }
          if (parsed.kind === 'issue') {
            const repo = repoById(forge, Number(parsed.parts[0]));
            const issue = repo?.issues.get(Number(parsed.parts[1]));
            return issue === undefined || repo === undefined ? null : { __gqlType: 'Issue', value: { repo, issue } };
          }
          if (parsed.kind === 'pr') {
            const repo = repoById(forge, Number(parsed.parts[0]));
            const pull = repo?.pulls.get(Number(parsed.parts[1]));
            return pull === undefined || repo === undefined ? null : { __gqlType: 'PullRequest', value: { repo, pull } };
          }
          if (parsed.kind === 'user') return { __gqlType: 'User', value: VIEWER };
          return null;
        },
      },
      rateLimit: { type: 'RateLimit', resolve: () => ({}) },
    },
  },
  Mutation: {
    kind: 'OBJECT',
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (forge, _source, args) => {
          const input = (args.input ?? {}) as Args;
          const parsed = parseGid(String(input.repositoryId ?? ''));
          const repo = parsed !== null && parsed.kind === 'repo' ? repoById(forge, Number(parsed.parts[0])) : undefined;
          if (repo === undefined) throw new Error('repository not found');
          const issue = createIssue(forge, repo, { title: input.title, body: input.body });
          return { repo, issue, clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (forge, _source, args) => {
          const input = (args.input ?? {}) as Args;
          const parsed = parseGid(String(input.issueId ?? ''));
          const repo = parsed !== null ? repoById(forge, Number(parsed.parts[0])) : undefined;
          const issue = repo?.issues.get(Number(parsed?.parts[1]));
          if (repo === undefined || issue === undefined) throw new Error('issue not found');
          issue.state = 'closed';
          issue.updatedAt = nowIso();
          return { repo, issue, clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (forge, _source, args) => {
          const input = (args.input ?? {}) as Args;
          const parsed = parseGid(String(input.repositoryId ?? ''));
          const repo = parsed !== null && parsed.kind === 'repo' ? repoById(forge, Number(parsed.parts[0])) : undefined;
          if (repo === undefined) throw new Error('repository not found');
          const pull = createPull(forge, repo, {
            title: input.title,
            body: input.body,
            head: input.headRefName,
            base: input.baseRefName,
          });
          return { repo, pull, clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (forge, _source, args) => {
          const input = (args.input ?? {}) as Args;
          const parsed = parseGid(String(input.pullRequestId ?? ''));
          const repo = parsed !== null ? repoById(forge, Number(parsed.parts[0])) : undefined;
          const pull = repo?.pulls.get(Number(parsed?.parts[1]));
          if (repo === undefined || pull === undefined) throw new Error('pull request not found');
          const methodName = String(input.mergeMethod ?? 'MERGE').toUpperCase();
          const method: MergeMethod = methodName === 'SQUASH' ? 'squash' : methodName === 'REBASE' ? 'rebase' : 'merge';
          mergePull(forge, repo, pull, method);
          return { repo, pull, clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (forge, _source, args) => {
          const input = (args.input ?? {}) as Args;
          const parsed = parseGid(String(input.subjectId ?? ''));
          if (parsed === null) throw new Error('subject not found');
          const repo = repoById(forge, Number(parsed.parts[0]));
          if (repo === undefined) throw new Error('subject not found');
          const number = Number(parsed.parts[1]);
          const target = parsed.kind === 'pr' ? repo.pulls.get(number) : repo.issues.get(number);
          if (target === undefined) throw new Error('subject not found');
          const comment = addComment(forge, target, typeof input.body === 'string' ? input.body : '');
          return { repo, number, comment, clientMutationId: input.clientMutationId ?? null };
        },
      },
    },
  },
  User: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: () => userGid() },
      login: { type: 'String', resolve: () => VIEWER.login },
      name: { type: 'String', resolve: () => VIEWER.name },
      email: { type: 'String', resolve: () => VIEWER.email },
    },
  },
  Repository: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (_forge, repo: RepoRec) => repoGid(repo) },
      databaseId: { type: 'Int', resolve: (_forge, repo: RepoRec) => repo.id },
      name: { type: 'String', resolve: (_forge, repo: RepoRec) => repo.name },
      nameWithOwner: { type: 'String', resolve: (_forge, repo: RepoRec) => `${VIEWER.login}/${repo.name}` },
      description: { type: 'String', resolve: (_forge, repo: RepoRec) => repo.description },
      isPrivate: { type: 'Boolean', resolve: (_forge, repo: RepoRec) => repo.private },
      owner: { type: 'User', resolve: () => VIEWER },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (forge, repo: RepoRec) => (repo.refs.has(forge.headRef(repo)) ? { name: repo.defaultBranch } : null),
      },
      viewerPermission: { type: 'RepositoryPermission', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
      url: { type: 'URI', resolve: () => '' },
      issue: {
        type: 'Issue',
        resolve: (_forge, repo: RepoRec, args) => {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : { repo, issue };
        },
      },
      issues: { type: 'IssueConnection', resolve: (forge, repo: RepoRec, args) => issuesConnection(forge, repo, args) },
      pullRequest: {
        type: 'PullRequest',
        resolve: (_forge, repo: RepoRec, args) => {
          const pull = repo.pulls.get(Number(args.number));
          return pull === undefined ? null : { repo, pull };
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (_forge, repo: RepoRec, args) => {
          let list = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const states = args.states as string[] | undefined;
          if (Array.isArray(states) && states.length > 0) {
            list = list.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED'));
          }
          const first = typeof args.first === 'number' ? Math.max(0, args.first) : list.length;
          return { repo, nodes: list.slice(0, first), hasNextPage: first < list.length, endCursor: null, totalCount: list.length };
        },
      },
    },
  },
  Ref: {
    kind: 'OBJECT',
    fields: {
      name: { type: 'String', resolve: scalar((source) => source.name) },
      prefix: { type: 'String', resolve: () => 'refs/heads/' },
    },
  },
  Issue: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (_forge, at: IssueAt) => issueGid(at.repo, at.issue) },
      number: { type: 'Int', resolve: (_forge, at: IssueAt) => at.issue.number },
      title: { type: 'String', resolve: (_forge, at: IssueAt) => at.issue.title },
      body: { type: 'String', resolve: (_forge, at: IssueAt) => at.issue.body },
      state: { type: 'IssueState', resolve: (_forge, at: IssueAt) => (at.issue.state === 'open' ? 'OPEN' : 'CLOSED') },
      repository: { type: 'Repository', resolve: (_forge, at: IssueAt) => at.repo },
      url: { type: 'URI', resolve: () => '' },
    },
  },
  IssueConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[Issue]', resolve: (_forge, source) => (source.nodes as IssueRec[]).map((issue) => ({ repo: source.repo, issue })) },
      edges: {
        type: '[IssueEdge]',
        resolve: (_forge, source) =>
          (source.nodes as IssueRec[]).map((issue) => ({ repo: source.repo, issue, cursor: cursorFor(issue.number) })),
      },
      pageInfo: { type: 'PageInfo', resolve: (_forge, source) => source },
      totalCount: { type: 'Int', resolve: (_forge, source) => source.totalCount },
    },
  },
  IssueEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'Issue', resolve: (_forge, source) => ({ repo: source.repo, issue: source.issue }) },
      cursor: { type: 'String', resolve: (_forge, source) => source.cursor },
    },
  },
  PageInfo: {
    kind: 'OBJECT',
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (_forge, source) => source.hasNextPage === true },
      hasPreviousPage: { type: 'Boolean', resolve: () => false },
      startCursor: { type: 'String', resolve: (_forge, source) => source.endCursor ?? null },
      endCursor: { type: 'String', resolve: (_forge, source) => source.endCursor ?? null },
    },
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (_forge, at: PullAt) => pullGid(at.repo, at.pull) },
      number: { type: 'Int', resolve: (_forge, at: PullAt) => at.pull.number },
      title: { type: 'String', resolve: (_forge, at: PullAt) => at.pull.title },
      body: { type: 'String', resolve: (_forge, at: PullAt) => at.pull.body },
      state: {
        type: 'PullRequestState',
        resolve: (_forge, at: PullAt) => (at.pull.merged ? 'MERGED' : at.pull.state === 'open' ? 'OPEN' : 'CLOSED'),
      },
      merged: { type: 'Boolean', resolve: (_forge, at: PullAt) => at.pull.merged },
      mergedAt: { type: 'DateTime', resolve: (_forge, at: PullAt) => at.pull.mergedAt },
      headRefName: { type: 'String', resolve: (_forge, at: PullAt) => at.pull.headRef },
      baseRefName: { type: 'String', resolve: (_forge, at: PullAt) => at.pull.baseRef },
      mergeable: { type: 'MergeableState', resolve: (forge, at: PullAt) => pullMergeable(forge, at.repo, at.pull) },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (forge, at: PullAt, args) => {
          const changes = pullFiles(forge, at.repo, at.pull);
          const first = typeof args.first === 'number' ? Math.max(0, args.first) : changes.length;
          return { nodes: changes.slice(0, first), totalCount: changes.length };
        },
      },
      repository: { type: 'Repository', resolve: (_forge, at: PullAt) => at.repo },
      url: { type: 'URI', resolve: () => '' },
    },
  },
  PullRequestConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequest]', resolve: (_forge, source) => (source.nodes as PullRec[]).map((pull) => ({ repo: source.repo, pull })) },
      pageInfo: { type: 'PageInfo', resolve: (_forge, source) => source },
      totalCount: { type: 'Int', resolve: (_forge, source) => source.totalCount },
    },
  },
  PullRequestChangedFileConnection: {
    kind: 'OBJECT',
    fields: {
      nodes: { type: '[PullRequestChangedFile]', resolve: (_forge, source) => source.nodes },
      totalCount: { type: 'Int', resolve: (_forge, source) => source.totalCount },
    },
  },
  PullRequestChangedFile: {
    kind: 'OBJECT',
    fields: {
      path: { type: 'String', resolve: (_forge, change) => change.path },
      additions: { type: 'Int', resolve: (_forge, change) => change.additions },
      deletions: { type: 'Int', resolve: (_forge, change) => change.deletions },
      changeType: { type: 'String', resolve: (_forge, change) => String(change.status).toUpperCase() },
    },
  },
  IssueComment: {
    kind: 'OBJECT',
    fields: {
      id: { type: 'ID', resolve: (_forge, source) => commentGid(source.repo, source.number, source.comment.id) },
      body: { type: 'String', resolve: (_forge, source) => source.comment.body },
    },
  },
  CreateIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (_forge, source) => ({ repo: source.repo, issue: source.issue }) },
      clientMutationId: { type: 'String', resolve: (_forge, source) => source.clientMutationId },
    },
  },
  CloseIssuePayload: {
    kind: 'OBJECT',
    fields: {
      issue: { type: 'Issue', resolve: (_forge, source) => ({ repo: source.repo, issue: source.issue }) },
      clientMutationId: { type: 'String', resolve: (_forge, source) => source.clientMutationId },
    },
  },
  CreatePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (_forge, source) => ({ repo: source.repo, pull: source.pull }) },
      clientMutationId: { type: 'String', resolve: (_forge, source) => source.clientMutationId },
    },
  },
  MergePullRequestPayload: {
    kind: 'OBJECT',
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (_forge, source) => ({ repo: source.repo, pull: source.pull }) },
      clientMutationId: { type: 'String', resolve: (_forge, source) => source.clientMutationId },
    },
  },
  AddCommentPayload: {
    kind: 'OBJECT',
    fields: {
      commentEdge: { type: 'CommentEdge', resolve: (_forge, source) => source },
      clientMutationId: { type: 'String', resolve: (_forge, source) => source.clientMutationId },
    },
  },
  CommentEdge: {
    kind: 'OBJECT',
    fields: {
      node: { type: 'IssueComment', resolve: (_forge, source) => source },
      cursor: { type: 'String', resolve: () => '' },
    },
  },
  RateLimit: {
    kind: 'OBJECT',
    fields: {
      limit: { type: 'Int', resolve: () => 5000 },
      remaining: { type: 'Int', resolve: () => 5000 },
      resetAt: { type: 'DateTime', resolve: () => nowIso() },
      cost: { type: 'Int', resolve: () => 1 },
    },
  },
  Node: { kind: 'OBJECT', fields: { id: { type: 'ID', resolve: () => '' } } },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  CreateIssueInput: { kind: 'INPUT_OBJECT' },
  CloseIssueInput: { kind: 'INPUT_OBJECT' },
  CreatePullRequestInput: { kind: 'INPUT_OBJECT' },
  MergePullRequestInput: { kind: 'INPUT_OBJECT' },
  AddCommentInput: { kind: 'INPUT_OBJECT' },
};

// ------------------------------------------------------------ introspection

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'URI', 'DateTime']);

function bareTypeName(type: string): string {
  return type.replace(/[[\]!]/g, '');
}

SCHEMA.__Type = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String', resolve: (_forge, source) => source.name },
    kind: {
      type: 'String',
      resolve: (_forge, source) => {
        const def = SCHEMA[source.name as string];
        if (def !== undefined) return def.kind;
        return SCALARS.has(source.name as string) ? 'SCALAR' : 'OBJECT';
      },
    },
    description: { type: 'String', resolve: () => null },
    fields: {
      type: '[__Field]',
      resolve: (_forge, source) => {
        const def = SCHEMA[source.name as string];
        if (def === undefined || def.kind !== 'OBJECT' || def.fields === undefined) return null;
        return Object.entries(def.fields).map(([name, field]) => ({ __gqlType: '__Field', value: { name, type: field.type } }));
      },
    },
    enumValues: {
      type: '[__EnumValue]',
      resolve: (_forge, source) => {
        const def = SCHEMA[source.name as string];
        if (def === undefined || def.kind !== 'ENUM' || def.enumValues === undefined) return null;
        return def.enumValues.map((name) => ({ __gqlType: '__EnumValue', value: { name } }));
      },
    },
    inputFields: { type: '[__InputValue]', resolve: () => null },
    possibleTypes: { type: '[__Type]', resolve: () => null },
    ofType: { type: '__Type', resolve: () => null },
    specifiedByURL: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__Field = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String', resolve: (_forge, source) => source.name },
    description: { type: 'String', resolve: () => null },
    type: { type: '__Type', resolve: (_forge, source) => ({ __gqlType: '__Type', value: { name: bareTypeName(source.type as string) } }) },
    args: { type: '[__InputValue]', resolve: () => [] },
    isDeprecated: { type: 'Boolean', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__EnumValue = {
  kind: 'OBJECT',
  fields: {
    name: { type: 'String', resolve: (_forge, source) => source.name },
    description: { type: 'String', resolve: () => null },
    isDeprecated: { type: 'Boolean', resolve: () => false },
    deprecationReason: { type: 'String', resolve: () => null },
  },
};

SCHEMA.__Schema = {
  kind: 'OBJECT',
  fields: {
    types: {
      type: '[__Type]',
      resolve: () => [...Object.keys(SCHEMA), ...SCALARS].map((name) => ({ __gqlType: '__Type', value: { name } })),
    },
    queryType: { type: '__Type', resolve: () => ({ __gqlType: '__Type', value: { name: 'Query' } }) },
    mutationType: { type: '__Type', resolve: () => ({ __gqlType: '__Type', value: { name: 'Mutation' } }) },
    subscriptionType: { type: '__Type', resolve: () => null },
    directives: { type: '[__Directive]', resolve: () => [] },
  },
};

// ------------------------------------------------------------ executor

interface ExecCtx {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string; selectionSet: GqlSelection[] }>;
  errors: Array<{ message: string }>;
}

function completeValue(ctx: ExecCtx, type: string, raw: unknown, selectionSet: GqlSelection[] | undefined): unknown {
  if (raw === null || raw === undefined) return null;
  const trimmed = type.endsWith('!') ? type.slice(0, -1) : type;
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    if (!Array.isArray(raw)) return null;
    const inner = trimmed.slice(1, -1);
    return raw.map((entry) => completeValue(ctx, inner, entry, selectionSet));
  }
  if (SCALARS.has(trimmed)) return trimmed === 'ID' ? String(raw) : raw;
  const def = SCHEMA[trimmed];
  if (def !== undefined && def.kind === 'ENUM') return raw;
  let runtimeType = trimmed;
  let source: unknown = raw;
  if (typeof raw === 'object' && raw !== null && '__gqlType' in raw) {
    runtimeType = (raw as { __gqlType: string }).__gqlType;
    source = (raw as { value: unknown }).value;
  }
  if (selectionSet === undefined) return null;
  return execSet(ctx, runtimeType, source, selectionSet);
}

function execSet(ctx: ExecCtx, typeName: string, source: unknown, selections: GqlSelection[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = SCHEMA[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === undefined || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, execSet(ctx, typeName, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment !== undefined && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, execSet(ctx, typeName, source, fragment.selectionSet));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const args: Args = {};
    for (const [name, value] of selection.args) args[name] = resolveValue(value, ctx.variables);
    if (selection.name === '__type' && typeName === 'Query') {
      const name = String(args.name ?? '');
      out[key] = SCHEMA[name] !== undefined || SCALARS.has(name)
        ? completeValue(ctx, '__Type', { __gqlType: '__Type', value: { name } }, selection.selectionSet)
        : null;
      continue;
    }
    if (selection.name === '__schema' && typeName === 'Query') {
      out[key] = completeValue(ctx, '__Schema', { __gqlType: '__Schema', value: {} }, selection.selectionSet);
      continue;
    }
    const field = typeDef?.fields?.[selection.name];
    if (field === undefined) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let raw: unknown;
    try {
      raw = field.resolve(ctx.forge, source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, field.type, raw, selection.selectionSet);
  }
  return out;
}

interface GraphQLOperationBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function executeOne(forge: Forge, body: GraphQLOperationBody): Record<string, unknown> {
  if (body === null || typeof body !== 'object' || typeof body.query !== 'string') {
    return { errors: [{ message: 'a GraphQL request body must carry a query string' }] };
  }
  let document;
  try {
    document = parseGraphQL(body.query);
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : 'could not parse the document' }] };
  }
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  const operation: GqlOperation | undefined =
    operationName !== undefined ? document.operations.find((entry) => entry.name === operationName) : document.operations[0];
  if (operation === undefined) return { errors: [{ message: 'no operation to execute' }] };
  const variables: Record<string, unknown> = {};
  for (const [name, def] of operation.variableDefinitions) {
    if (def.defaultValue !== undefined) variables[name] = resolveValue(def.defaultValue, {});
  }
  if (body.variables !== null && typeof body.variables === 'object') {
    for (const [name, value] of Object.entries(body.variables as Record<string, unknown>)) variables[name] = value;
  }
  const ctx: ExecCtx = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = execSet(ctx, rootType, null, operation.selectionSet);
  const result: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) result.errors = ctx.errors;
  return result;
}

/** POST /api/graphql: one operation document, or a JSON array of them. */
export function handleGraphQL(forge: Forge, body: unknown): { status: number; body: unknown } {
  if (Array.isArray(body)) {
    return { status: 200, body: body.map((entry) => executeOne(forge, (entry ?? {}) as GraphQLOperationBody)) };
  }
  return { status: 200, body: executeOne(forge, (body ?? {}) as GraphQLOperationBody) };
}
