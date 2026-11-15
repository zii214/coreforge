# A GitHub-compatible git forge

One Node process (standard library only, no git binary, no packages) serving four surfaces over a
single in-memory store:

- **Git smart HTTP** at `/{owner}/{repo}.git` — protocol v2 upload-pack (capability advertisement,
  ls-refs, fetch with shallow/deepen support) and protocol v0 upload-pack with side-band-64k, plus
  v0 receive-pack with report-status and fast-forward-only ref updates. The object model (blobs,
  trees, commits, annotated tags), packfile reading/writing and delta resolution are implemented
  from the wire format up.
- **REST v3** under `/api/v3` — repositories, contents, labels, issues, comments, pull requests
  (squash merge with three-way conflict detection), git refs, branches and commit lists.
- **GraphQL** at `/api/graphql` — a small parser/executor for the documents gh and
  github-mcp-server send: viewer, repository, issues/pullRequests connections with cursors and
  ordering, the createIssue/closeIssue/createPullRequest/mergePullRequest/addComment mutations,
  batched operations, and the introspection surface (`__type` for Issue, PullRequest, Repository,
  SearchType, …).
- **MCP** at `/mcp` — JSON-RPC 2.0 Streamable HTTP speaking revision 2026-07-28 via
  `server/discover` (with the legacy initialize handshake as fallback) and seven tools
  (create_repo, get_repo, list_repos, create_issue, list_issues, create_pull_request,
  merge_pull_request) acting on the same store as REST.

## Running

```
MAKEFUN_ENV_URL=http://env:8080 MAKEFUN_SHOP_TOKEN=<token> node --experimental-strip-types main.ts
```

`main.ts` binds an ephemeral port, registers it with the env, and polls `/done` until the trial
ends. Authentication is the bearer token on every surface but `/healthz`. All state is in memory
and deterministic: object ids are SHA-1 over content, record ids come from counters, and
timestamps come from a logical clock — the same sequence of operations always produces the same
bytes.

## Layout

- `main.ts` — the entry ↔ env lifecycle (register, poll, exit).
- `app.ts` — HTTP routing, authentication, request ids.
- `lib/store.ts` — the store: repositories, the git object database, trees, ancestry, three-way
  merges, diffs.
- `lib/git.ts` — pkt-lines, packfiles, upload-pack/receive-pack.
- `lib/records.ts` — the serializers and write operations shared by REST, GraphQL and MCP.
- `lib/rest.ts`, `lib/graphql.ts`, `lib/mcp.ts` — the three API surfaces.
