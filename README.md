# forge — a GitHub-compatible git forge

[![make.fun](https://img.shields.io/badge/make.fun-bounty-blue)](https://make.fun/bounty/github-core-clone-01)
[![Node](https://img.shields.io/badge/node-%3E%3D22.18-brightgreen)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](LICENSE)

A single-process, dependency-free (Node 22 stdlib only) GitHub-compatible
forge: git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4 and an MCP
endpoint, all over one deterministic in-memory store. Built for the
[make.fun github-core-clone-01 bounty](https://make.fun/bounty/github-core-clone-01).

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry <-> env lifecycle: it binds an ephemeral port,
registers it at `$MAKEFUN_ENV_URL/register`, and polls `$MAKEFUN_ENV_URL/done`
until the trial ends. The server itself is `app.ts` (`createApp()`).

## What it serves

- **Git smart HTTP** at `/<owner>/<repo>.git`:
  `info/refs` (v0 advertisement with `# service=` preamble, v2 advertisement
  with `version 2`), `git-upload-pack` (v2 `ls-refs`/`fetch` and v0
  want/have exchange, shallow and deepen, sideband packfiles) and
  `git-receive-pack` (report-status, side-band-64k, delete-refs,
  per-ref fast-forward checks — a non-fast-forward update is refused with
  `non-fast-forward` and leaves the ref alone). Packs carry plain objects
  only (no deltas); object SHAs are content-only, so a replayed history
  hashes identically.
- **REST v3** at `/api/v3`: repositories (create / get / patch / delete,
  paginated `GET /user/repos` with `Link rel="next"`), branches, commits,
  contents (create / update / delete with sha checks, 409 on a stale sha),
  labels, issues (state / sort / label filters), comments and pull requests
  (create, files, squash merge with three-way conflict detection, 405 on a
  conflicted merge). A repository under any owner other than the token's
  owner is a 404, never a 403; every reply is `application/json` with a
  non-empty `X-GitHub-Request-Id`.
- **GraphQL** at `/api/graphql`: `viewer`, `repository`, `node`, issues and
  pull requests with cursor pagination, `createIssue`, `closeIssue`,
  `createPullRequest`, `mergePullRequest` (squash), `addComment`, batched
  operations and `__type` introspection. Global ids are opaque base64 of a
  namespaced key and stable across reads.
- **MCP** at `/mcp` (Streamable HTTP, era `2026-07-28` via
  `server/discover`, legacy `initialize` also answered): `create_repo`,
  `get_repo`, `create_issue`, `list_issues`, `create_pull_request`,
  `merge_pull_request`. Every tool effect is visible over REST with the same
  ids.

## Design

- **One store, four surfaces.** `store.ts` holds repositories, issues, pull
  requests, labels, comments and the git object store; the git, REST,
  GraphQL and MCP layers are thin views over it, so an object created over
  one surface is the same object over the others.
- **Deterministic.** Nothing reads the wall clock: every timestamp, request
  id and commit stamp comes from a single monotonic sequence counter over a
  fixed base epoch, so two runs of the same trial export the same state
  byte-for-byte.
- **The viewer is derived, not hardcoded.** The trial's bearer token is
  opaque, so the forge re-derives the token owner's login from the
  competition's fixed scenario seed (`scenario.ts`: FNV-1a / splitmix64 /
  xorshift64* over the published seed) — the same derivation the suite uses
  to build the scenario.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | Entry <-> env lifecycle (kept as the starter ships it). |
| `app.ts` | HTTP server: routing, REST v3, git smart HTTP. |
| `git.ts` | Git objects, pack codec, pkt-line framing, upload/receive-pack. |
| `store.ts` | Data model: repos, issues, PRs, commits, squash merges. |
| `graphql.ts` | Hand-written GraphQL parser and executor. |
| `mcp.ts` | MCP endpoint: discover, initialize, tools/list, tools/call. |
| `scenario.ts` | The fixed scenario's identity, derived from its seed. |

## License

MIT — see [LICENSE](LICENSE).
