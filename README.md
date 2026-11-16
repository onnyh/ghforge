# ghforge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/onnyh/ghforge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/onnyh/ghforge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node 22 process, built
for make.fun's `github-core-clone-01`. No UI, no database, no git binary:
the forge keeps its own in-memory store and speaks every surface itself.

## Surfaces

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 `ls-refs` and
  `fetch` (with shallow/deepen), the v0 fetch fallback, and v0
  `receive-pack` pushes with report-status and fast-forward enforcement.
- **REST v3** under `/api/v3` — repositories, contents, git refs, branches,
  commits, labels, issues, comments and pull requests (including merges:
  merge, squash and rebase).
- **GraphQL v4** at `/api/graphql` — the queries and mutations `gh` and
  github-mcp-server send, cursor pagination, Relay global ids, batching and
  introspection.
- **MCP** at `/mcp` — JSON-RPC 2.0 (revision 2026-07-28 via
  `server/discover`, with the legacy initialize handshake) and six tools:
  `create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, all acting on the same store
  as REST.

## Running

```sh
node main.ts
```

The process binds an ephemeral port. Under the suite it registers the port
with `$MAKEFUN_ENV_URL/register` and exits when the suite reports done;
standalone it serves until stopped. Authentication is the bearer token in
`MAKEFUN_SHOP_TOKEN`. All timestamps derive from `MAKEFUN_TRIAL_NOW`, so a
replayed trial rebuilds byte-identical state.

## Layout

- `main.ts` — the lifecycle (bind, register, poll /done, exit).
- `src/app.ts` — HTTP routing and the cross-cutting wire rules.
- `src/store.ts` — the in-memory forge: repositories, objects, refs, issues.
- `src/gitobj.ts`, `src/pack.ts`, `src/pktline.ts` — the git object model,
  packfiles and pkt-line framing.
- `src/gitproto.ts` — smart HTTP upload-pack/receive-pack.
- `src/trees.ts` — tree reads/writes, diffs and three-way merges.
- `src/records.ts` — the issue/pull-request operations every surface shares.
- `src/rest.ts`, `src/graphql.ts`, `src/gqlparse.ts`, `src/mcp.ts` — the
  three API surfaces.
- `src/clock.ts` — the deterministic trial clock.

## License

MIT — see `LICENSE`.
