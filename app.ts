// The forge's HTTP server: git smart HTTP at /<owner>/<repo>.git, REST v3 at
// /api/v3, GraphQL at /api/graphql and MCP at /mcp — all over one in-memory
// store. One process, no database, no wall clock: every timestamp and
// request id comes from the store's monotonic sequence counter, so a replayed
// trial exports the same state byte-for-byte.
//
// Routing notes the suite depends on:
//   - git lives at /<owner>/<repo>.git/info/refs and .../git-upload-pack /
//     git-receive-pack (the .git suffix is part of the path);
//   - a repository under any owner other than the viewer is a 404, never a
//     403 (the token is opaque and names no login of its own);
//   - every REST reply carries application/json and a non-empty
//     X-GitHub-Request-Id; list replies paginate with an absolute Link
//     rel="next" on the entry's own origin.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';
import { ForgeStore, isoTimestamp, authorLine, type Repo, type Issue, type PullRequest } from './store.ts';
import {
  advertisementV0,
  advertisementV2,
  handleLsRefs,
  handleFetchV2,
  handleFetchV0,
  handleReceivePack,
  parseV2Command,
  parseV0Fetch,
  decodePktLines,
  hashObject,
  parseCommit,
  parseTree,
  buildTree,
  peelToCommit,
  isObjectId,
  type GitObjectType,
} from './git.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers: Readonly<Record<string, string>> = {}): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length, ...headers });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  return match ? (match[1] as string) : null;
}

function pathSegments(req: IncomingMessage): string[] {
  try {
    const pathname = new URL(req.url ?? '/', 'http://entry').pathname;
    return pathname
      .split('/')
      .filter((segment) => segment.length > 0)
      .map((segment) => {
        try {
          return decodeURIComponent(segment);
        } catch {
          return segment;
        }
      });
  } catch {
    return [];
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function baseUrlOf(req: IncomingMessage): string {
  return `http://${req.headers.host ?? 'localhost'}`;
}

/** Slice `items` to one page and build GitHub's Link header (absolute URLs). */
function paginate<T>(req: IncomingMessage, items: readonly T[], query: URLSearchParams): { page: T[]; link: string | null } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '1', 10);
  const pageNum = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (pageNum - 1) * perPage;
  const page = items.slice(start, start + perPage);
  const base = baseUrlOf(req);
  const path = new URL(req.url ?? '/', 'http://entry').pathname;
  const linkFor = (pageValue: number): string => {
    const next = new URLSearchParams(query);
    next.set('page', String(pageValue));
    next.set('per_page', String(perPage));
    return `<${base}${path}?${next.toString()}>`;
  };
  const links: string[] = [];
  if (start + perPage < items.length) links.push(`${linkFor(pageNum + 1)}; rel="next"`);
  if (pageNum > 1) links.push(`${linkFor(1)}; rel="first"`);
  if (start + perPage < items.length) {
    const last = Math.max(1, Math.ceil(items.length / perPage));
    links.push(`${linkFor(last)}; rel="last"`);
    if (pageNum > 1) links.push(`${linkFor(pageNum - 1)}; rel="prev"`);
  }
  return { page, link: links.length > 0 ? links.join(', ') : null };
}

function linkHeader(link: string | null): Record<string, string> {
  return link === null ? {} : { link };
}

// ---------------------------------------------------------------------------------------------
// serializers (REST shapes)
// ---------------------------------------------------------------------------------------------

function userJson(login: string): Record<string, unknown> {
  return {
    login,
    id: login === VIEWER.login ? VIEWER.id : 0,
    node_id: ForgeStore.globalId('U', login),
    avatar_url: `https://example.invalid/avatars/${login}`,
    type: 'User',
    site_admin: false,
    name: login === VIEWER.login ? VIEWER.name : login,
    email: login === VIEWER.login ? VIEWER.email : null,
  };
}

function repoJson(repo: Repo): Record<string, unknown> {
  const base = `https://example.invalid/${repo.owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: ForgeStore.globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.isPrivate,
    html_url: base,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://example.invalid/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@example.invalid:${repo.owner}/${repo.name}.git`,
    clone_url: `${base}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: false,
    has_downloads: true,
    has_wiki: false,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    open_issues_count: repo.issues.filter((issue) => issue.state === 'open').length,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    default_branch: repo.defaultBranch,
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.find((item) => item.name === name);
  return {
    id: 0,
    node_id: ForgeStore.globalId('L', `${repo.owner}/${repo.name}#${name}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? '000000',
    default: false,
    description: label?.description ?? '',
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.number,
    node_id: ForgeStore.globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
    url: `${base}/issues/${issue.number}`,
    repository_url: base,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(VIEWER.login),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    locked: false,
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: Issue, comment: Issue['comments'][number]): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: ForgeStore.globalId('C', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    author_association: 'OWNER',
  };
}

function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: pull.number,
    node_id: ForgeStore.globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
    url: `${base}/pulls/${pull.number}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(VIEWER.login),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    mergeable: pull.state === 'open',
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha, user: userJson(repo.owner), repo: repoJson(repo) },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha, user: userJson(repo.owner), repo: repoJson(repo) },
  };
}

function objectType(repo: Repo, oid: string): GitObjectType {
  const object = repo.objects.get(oid);
  return object ? object.type : 'commit';
}

// ---------------------------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------------------------

export function createApp(): Server {
  const store = new ForgeStore();

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = `req-${store.nextSeq()}`;
      const headers: Record<string, string> = { 'x-github-request-id': requestId };
      const method = req.method ?? 'GET';
      const segments = pathSegments(req);
      const query = queryOf(req);
      const send = (status: number, body: unknown, extra: Record<string, string> = {}): void => sendJson(res, status, body, { ...headers, ...extra });
      const fail = (status: number, message: string): void => send(status, { message });
      const notFound = (): void => fail(404, 'Not Found');
      const unauthorized = (): void => fail(401, 'Requires authentication');

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root.
        if (method === 'GET' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'v3') {
          send(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // --- git smart HTTP: /<owner>/<repo>.git/... -------------------------
        if (segments.length >= 2 && segments[1]?.endsWith('.git') === true) {
          await handleGit(req, res, store, segments, headers);
          return;
        }

        // --- GraphQL ---------------------------------------------------------
        if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          if (method !== 'POST') {
            send(405, { message: 'Method Not Allowed' });
            return;
          }
          if (bearerToken(req) === null) {
            unauthorized();
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJson(raw.toString('utf8'));
          if (!parsed.ok) {
            send(400, { errors: [{ message: 'Malformed JSON body.' }] });
            return;
          }
          const outcome = handleGraphQL(store, parsed.value);
          send(outcome.status, outcome.body);
          return;
        }

        // --- MCP -------------------------------------------------------------
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method === 'DELETE') {
            send(405, { message: 'Method Not Allowed' });
            return;
          }
          if (method !== 'POST') {
            send(405, { message: 'Method Not Allowed' });
            return;
          }
          const raw = await readBody(req);
          const outcome = handleMcp(store, raw, bearerToken(req) !== null);
          if (outcome.status === 202) {
            res.writeHead(202, { ...headers });
            res.end();
            return;
          }
          send(outcome.status, outcome.body);
          return;
        }

        // --- REST v3 ---------------------------------------------------------
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          if (bearerToken(req) === null) {
            unauthorized();
            return;
          }
          const raw = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);
          let body: unknown = {};
          if (raw.length > 0) {
            const parsed = parseJson(raw.toString('utf8'));
            if (!parsed.ok) {
              fail(400, 'Problems parsing JSON');
              return;
            }
            body = parsed.value;
          }
          await handleRest(req, res, store, segments.slice(2), query, method, body, send, fail, notFound);
          return;
        }

        notFound();
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : String(err) }, headers);
        } else {
          res.end();
        }
      }
    })();
  });
}

// ---------------------------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------------------------

type Send = (status: number, body: unknown, extra?: Record<string, string>) => void;
type Fail = (status: number, message: string) => void;

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

async function handleRest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  segments: string[],
  query: URLSearchParams,
  method: string,
  body: unknown,
  send: Send,
  fail: Fail,
  notFound: () => void,
): Promise<void> {
  const data = asObject(body);

  // GET /user — the token's owner.
  if (segments.length === 1 && segments[0] === 'user') {
    if (method !== 'GET') {
      fail(405, 'Method Not Allowed');
      return;
    }
    send(200, userJson(VIEWER.login));
    return;
  }

  // GET/POST /user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const repos = [...store.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
      const { page, link } = paginate(req, repos, query);
      send(200, page.map((repo) => repoJson(repo)), linkHeader(link));
      return;
    }
    if (method === 'POST') {
      const name = typeof data.name === 'string' ? data.name : '';
      if (name.length === 0 || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        fail(422, 'Validation Failed: name is invalid');
        return;
      }
      if (store.getRepo(name)) {
        fail(422, 'Repository already exists');
        return;
      }
      const repo = store.createRepo(name, typeof data.description === 'string' ? data.description : '', data.private === true);
      send(201, repoJson(repo));
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  // /repos/:owner/:repo/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const repoName = segments[2] as string;
    // Any owner other than the viewer is a 404, never a 403.
    if (owner !== VIEWER.login) {
      notFound();
      return;
    }
    const repo = store.getRepo(repoName);
    const rest = segments.slice(3);

    // The repository itself.
    if (rest.length === 0) {
      if (!repo) {
        notFound();
        return;
      }
      if (method === 'GET') {
        send(200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        if (typeof data.description === 'string') repo.description = data.description;
        if (typeof data.private === 'boolean') repo.isPrivate = data.private;
        repo.updatedAt = isoTimestamp(store.nextSeq());
        send(200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(repoName);
        res.writeHead(204, { 'x-github-request-id': `req-${store.nextSeq()}` });
        res.end();
        return;
      }
      fail(405, 'Method Not Allowed');
      return;
    }

    if (!repo) {
      notFound();
      return;
    }

    // GET /repos/:owner/:repo/branches and /branches/:branch
    if (rest[0] === 'branches') {
      if (method !== 'GET') {
        fail(405, 'Method Not Allowed');
        return;
      }
      const branches = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid, url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}` }, protected: false }))
        .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      if (rest.length === 1) {
        const { page, link } = paginate(req, branches, query);
        send(200, page, linkHeader(link));
        return;
      }
      const branchName = rest.slice(1).join('/');
      const branch = branches.find((item) => item.name === branchName);
      if (!branch) {
        notFound();
        return;
      }
      send(200, branch);
      return;
    }

    // GET /repos/:owner/:repo/commits
    if (rest[0] === 'commits') {
      if (method !== 'GET') {
        fail(405, 'Method Not Allowed');
        return;
      }
      const branch = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${branch}`);
      if (tip === undefined) {
        send(200, []);
        return;
      }
      const commits = collectCommits(repo, tip);
      const { page, link } = paginate(req, commits, query);
      send(200, page, linkHeader(link));
      return;
    }

    // /repos/:owner/:repo/contents[/path]
    if (rest[0] === 'contents') {
      await handleContents(req, store, repo, rest.slice(1), query, method, data, send, fail, notFound);
      return;
    }

    // GET/POST /repos/:owner/:repo/labels
    if (rest[0] === 'labels' && rest.length === 1) {
      if (method === 'GET') {
        send(200, repo.labels.map((label) => ({ ...labelJson(repo, label.name), url: `/api/v3/repos/${owner}/${repoName}/labels/${encodeURIComponent(label.name)}` })));
        return;
      }
      if (method === 'POST') {
        const name = typeof data.name === 'string' ? data.name : '';
        if (name.length === 0) {
          fail(422, 'Validation Failed: name is required');
          return;
        }
        if (repo.labels.some((label) => label.name === name)) {
          fail(422, 'Label already exists');
          return;
        }
        repo.labels.push({ name, color: typeof data.color === 'string' ? data.color : '000000', description: typeof data.description === 'string' ? data.description : '' });
        send(201, labelJson(repo, name));
        return;
      }
      fail(405, 'Method Not Allowed');
      return;
    }

    // /repos/:owner/:repo/issues...
    if (rest[0] === 'issues') {
      await handleIssues(req, store, repo, rest.slice(1), query, method, data, send, fail, notFound);
      return;
    }

    // /repos/:owner/:repo/pulls...
    if (rest[0] === 'pulls') {
      await handlePulls(req, store, repo, rest.slice(1), query, method, data, send, fail, notFound);
      return;
    }

    // /repos/:owner/:repo/git/refs...
    if (rest[0] === 'git' && rest[1] === 'refs') {
      handleGitRefs(store, repo, rest.slice(2), method, data, send, fail, notFound);
      return;
    }

    notFound();
    return;
  }

  notFound();
}

/** The commits reachable from `tip`, newest first (by the commit's own stamp). */
function collectCommits(repo: Repo, tip: string): Record<string, unknown>[] {
  const seen = new Set<string>();
  const queue: string[] = [tip];
  const commits: Array<{ sha: string; timestamp: number; order: number }> = [];
  let order = 0;
  while (queue.length) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    const stamp = /(\d+) \+0000$/.exec(commit.committer);
    commits.push({ sha: oid, timestamp: stamp ? Number.parseInt(stamp[1] as string, 10) : 0, order: order++ });
    for (const parent of commit.parents) queue.push(parent);
  }
  commits.sort((a, b) => b.timestamp - a.timestamp || a.order - b.order);
  return commits.map(({ sha }) => {
    const object = repo.objects.get(sha) as { data: Buffer };
    const commit = parseCommit(object.data);
    const person = (line: string): { name: string; email: string; date: string } => {
      const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
      if (!match) return { name: line, email: '', date: '' };
      return { name: match[1] as string, email: match[2] as string, date: new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString() };
    };
    const author = person(commit.author);
    const committer = person(commit.committer);
    return {
      sha,
      node_id: ForgeStore.globalId('C', sha),
      commit: {
        author,
        committer,
        message: commit.message,
        tree: { sha: commit.tree, url: `/api/v3/repos/${repo.owner}/${repo.name}/git/trees/${commit.tree}` },
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/commits/${sha}`,
        comment_count: 0,
      },
      url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
      author: userJson(VIEWER.login),
      committer: userJson(VIEWER.login),
      parents: commit.parents.map((parent) => ({ sha: parent, url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${parent}`, html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${parent}` })),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function contentFileJson(repo: Repo, path: string, blobOid: string): Record<string, unknown> {
  const object = repo.objects.get(blobOid);
  const size = object ? object.data.length : 0;
  const name = path.split('/').pop() ?? path;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    content: object ? object.data.toString('base64') : '',
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    download_url: `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${path}`,
    _links: { git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`, self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`, html: `https://example.invalid/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}` },
  };
}

function contentDirJson(repo: Repo, path: string, treeOid: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const childPath = path.length > 0 ? `${path}/${entry.name}` : entry.name;
    const isDir = entry.mode === '40000';
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
      name: entry.name,
      path: childPath,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
      html_url: `https://example.invalid/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
      git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      download_url: isDir ? null : `https://example.invalid/${repo.owner}/${repo.name}/raw/${repo.defaultBranch}/${childPath}`,
      _links: {
        git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${childPath}`,
        html: `https://example.invalid/${repo.owner}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
      },
    };
  });
}

async function handleContents(
  req: IncomingMessage,
  store: ForgeStore,
  repo: Repo,
  pathParts: string[],
  query: URLSearchParams,
  method: string,
  data: Record<string, unknown>,
  send: Send,
  fail: Fail,
  notFound: () => void,
): Promise<void> {
  const path = pathParts.join('/');
  const branch = (typeof data.branch === 'string' && data.branch.length > 0 ? data.branch : query.get('ref')) ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName);

  if (method === 'GET') {
    if (tip === undefined) {
      notFound();
      return;
    }
    const tipObject = repo.objects.get(tip);
    if (!tipObject || tipObject.type !== 'commit') {
      notFound();
      return;
    }
    const rootTree = parseCommit(tipObject.data).tree;
    if (path.length === 0) {
      send(200, contentDirJson(repo, '', rootTree));
      return;
    }
    const flat = store.flattenTree(repo, rootTree);
    const blobOid = flat.get(path);
    if (blobOid !== undefined) {
      send(200, contentFileJson(repo, path, blobOid));
      return;
    }
    // A directory: walk the tree by segments.
    let current = rootTree;
    let found = true;
    for (const segment of pathParts) {
      const object = repo.objects.get(current);
      if (!object || object.type !== 'tree') {
        found = false;
        break;
      }
      const entry = parseTree(object.data).find((item) => item.name === segment);
      if (!entry || entry.mode !== '40000') {
        found = false;
        break;
      }
      current = entry.oid;
    }
    if (!found) {
      notFound();
      return;
    }
    send(200, contentDirJson(repo, path, current));
    return;
  }

  if (method === 'PUT') {
    const message = typeof data.message === 'string' ? data.message : 'Update file';
    const content = typeof data.content === 'string' ? data.content : '';
    let bytes: Buffer;
    try {
      bytes = Buffer.from(content.replace(/\s/g, ''), 'base64');
    } catch {
      fail(422, 'Validation Failed: content is not valid base64');
      return;
    }
    const givenSha = typeof data.sha === 'string' ? data.sha : null;
    const baseTree = tip === undefined ? null : parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
    const flat = baseTree === null ? new Map<string, string>() : store.flattenTree(repo, baseTree);
    const existing = flat.get(path);
    if (existing !== undefined) {
      if (givenSha === null || givenSha !== existing) {
        fail(409, 'Conflict: sha does not match the current file');
        return;
      }
    } else if (givenSha !== null) {
      fail(409, 'Conflict: sha does not match the current file');
      return;
    }
    const blobOid = store.putObject(repo, 'blob', bytes);
    flat.set(path, blobOid);
    const treeOid = store.buildTreeFromFlat(repo, flat);
    const parents = tip === undefined ? [] : [tip];
    const commitOid = store.createCommit(repo, treeOid, parents, message);
    repo.refs.set(refName, commitOid);
    repo.updatedAt = isoTimestamp(store.nextSeq());
    send(existing === undefined ? 201 : 200, {
      content: contentFileJson(repo, path, blobOid),
      commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email, date: isoTimestamp(store.nextSeq()) }, committer: { name: VIEWER.name, email: VIEWER.email, date: isoTimestamp(store.nextSeq()) } },
    });
    return;
  }

  if (method === 'DELETE') {
    const message = typeof data.message === 'string' ? data.message : 'Delete file';
    const givenSha = typeof data.sha === 'string' ? data.sha : null;
    if (tip === undefined) {
      notFound();
      return;
    }
    const baseTree = parseCommit((repo.objects.get(tip) as { data: Buffer }).data).tree;
    const flat = store.flattenTree(repo, baseTree);
    const existing = flat.get(path);
    if (existing === undefined || givenSha === null || givenSha !== existing) {
      fail(409, 'Conflict: sha does not match the current file');
      return;
    }
    flat.delete(path);
    const treeOid = store.buildTreeFromFlat(repo, flat);
    const commitOid = store.createCommit(repo, treeOid, [tip], message);
    repo.refs.set(refName, commitOid);
    repo.updatedAt = isoTimestamp(store.nextSeq());
    send(200, {
      commit: { sha: commitOid, message, author: { name: VIEWER.name, email: VIEWER.email, date: isoTimestamp(store.nextSeq()) }, committer: { name: VIEWER.name, email: VIEWER.email, date: isoTimestamp(store.nextSeq()) } },
    });
    return;
  }

  fail(405, 'Method Not Allowed');
}

// ---------------------------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------------------------

async function handleIssues(
  req: IncomingMessage,
  store: ForgeStore,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  method: string,
  data: Record<string, unknown>,
  send: Send,
  fail: Fail,
  notFound: () => void,
): Promise<void> {
  // GET/POST /issues
  if (rest.length === 0) {
    if (method === 'GET') {
      let items = [...repo.issues];
      const state = (query.get('state') ?? 'open').toLowerCase();
      if (state !== 'all') items = items.filter((issue) => issue.state === state);
      const labelsParam = query.get('labels');
      if (labelsParam) {
        const wanted = labelsParam.split(',').map((label) => label.trim()).filter((label) => label.length > 0);
        items = items.filter((issue) => wanted.every((label) => issue.labels.includes(label)));
      }
      const sort = query.get('sort') ?? 'created';
      const direction = (query.get('direction') ?? 'desc').toLowerCase();
      items.sort((a, b) => {
        const left = sort === 'updated' ? a.updatedAt : a.createdAt;
        const right = sort === 'updated' ? b.updatedAt : b.createdAt;
        if (left === right) return direction === 'asc' ? a.number - b.number : b.number - a.number;
        return direction === 'asc' ? (left < right ? -1 : 1) : (left < right ? 1 : -1);
      });
      const { page, link } = paginate(req, items, query);
      send(200, page.map((issue) => issueJson(repo, issue)), linkHeader(link));
      return;
    }
    if (method === 'POST') {
      const title = typeof data.title === 'string' ? data.title : '';
      if (title.length === 0) {
        fail(422, 'Validation Failed: title is required');
        return;
      }
      const labels = Array.isArray(data.labels) ? data.labels.filter((label): label is string => typeof label === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.some((known) => known.name === label)) {
          fail(422, `Validation Failed: label "${label}" does not exist`);
          return;
        }
      }
      const issue = store.createIssue(repo, title, typeof data.body === 'string' ? data.body : '', labels);
      send(201, issueJson(repo, issue));
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) {
    notFound();
    return;
  }
  const issue = repo.issues.find((item) => item.number === number);
  if (!issue) {
    notFound();
    return;
  }

  // GET/POST /issues/:number/comments
  if (rest.length === 2 && rest[1] === 'comments') {
    if (method === 'GET') {
      const { page, link } = paginate(req, issue.comments, query);
      send(200, page.map((comment) => commentJson(repo, issue, comment)), linkHeader(link));
      return;
    }
    if (method === 'POST') {
      const bodyText = typeof data.body === 'string' ? data.body : '';
      if (bodyText.length === 0) {
        fail(422, 'Validation Failed: body is required');
        return;
      }
      const comment = store.addComment(repo, issue, bodyText);
      send(201, commentJson(repo, issue, comment));
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  if (rest.length === 1) {
    if (method === 'GET') {
      send(200, issueJson(repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (typeof data.title === 'string') issue.title = data.title;
      if (typeof data.body === 'string') issue.body = data.body;
      if (data.state === 'open' || data.state === 'closed') issue.state = data.state;
      issue.updatedAt = isoTimestamp(store.nextSeq());
      send(200, issueJson(repo, issue));
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  notFound();
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

async function handlePulls(
  req: IncomingMessage,
  store: ForgeStore,
  repo: Repo,
  rest: string[],
  query: URLSearchParams,
  method: string,
  data: Record<string, unknown>,
  send: Send,
  fail: Fail,
  notFound: () => void,
): Promise<void> {
  // GET/POST /pulls
  if (rest.length === 0) {
    if (method === 'GET') {
      let items = [...repo.pulls];
      const state = (query.get('state') ?? 'open').toLowerCase();
      if (state !== 'all') items = items.filter((pull) => pull.state === state);
      items.sort((a, b) => b.createdSeq - a.createdSeq);
      const { page, link } = paginate(req, items, query);
      send(200, page.map((pull) => pullJson(repo, pull)), linkHeader(link));
      return;
    }
    if (method === 'POST') {
      const title = typeof data.title === 'string' ? data.title : '';
      const head = typeof data.head === 'string' ? data.head : '';
      const base = typeof data.base === 'string' ? data.base : '';
      if (title.length === 0 || head.length === 0 || base.length === 0) {
        fail(422, 'Validation Failed: title, head and base are required');
        return;
      }
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        fail(422, 'Validation Failed: head or base branch does not exist');
        return;
      }
      const pull = store.createPull(repo, title, typeof data.body === 'string' ? data.body : '', head, base);
      send(201, pullJson(repo, pull));
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  const number = Number.parseInt(rest[0] as string, 10);
  if (!Number.isFinite(number)) {
    notFound();
    return;
  }
  const pull = repo.pulls.find((item) => item.number === number);
  if (!pull) {
    notFound();
    return;
  }

  // GET /pulls/:number/files
  if (rest.length === 2 && rest[1] === 'files') {
    if (method !== 'GET') {
      fail(405, 'Method Not Allowed');
      return;
    }
    send(200, store.pullFileList(repo, pull));
    return;
  }

  // PUT /pulls/:number/merge
  if (rest.length === 2 && rest[1] === 'merge') {
    if (method !== 'PUT') {
      fail(405, 'Method Not Allowed');
      return;
    }
    if (pull.state !== 'open') {
      fail(405, 'Pull request is not open');
      return;
    }
    const sha = store.squashMerge(repo, pull);
    if (sha === null) {
      fail(405, 'Merge conflict');
      return;
    }
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = isoTimestamp(store.nextSeq());
    pull.state = 'closed';
    pull.updatedAt = pull.mergedAt;
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    send(200, { sha, merged: true, message: `Merge pull request #${pull.number} from ${pull.head}` });
    return;
  }

  if (rest.length === 1) {
    if (method !== 'GET') {
      fail(405, 'Method Not Allowed');
      return;
    }
    send(200, pullJson(repo, pull));
    return;
  }

  notFound();
}

// ---------------------------------------------------------------------------------------------
// git refs (REST)
// ---------------------------------------------------------------------------------------------

function handleGitRefs(
  store: ForgeStore,
  repo: Repo,
  rest: string[],
  method: string,
  data: Record<string, unknown>,
  send: Send,
  fail: Fail,
  notFound: () => void,
): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      const refs = store.gitView(repo).listRefs().map(({ name, oid }) => ({
        ref: name,
        node_id: ForgeStore.globalId('G', `${repo.owner}/${repo.name}#${name}`),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${name}`,
        object: { sha: oid, type: objectType(repo, oid), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType(repo, oid)}s/${oid}` },
      }));
      send(200, refs);
      return;
    }
    if (method === 'POST') {
      const ref = typeof data.ref === 'string' ? data.ref : '';
      const sha = typeof data.sha === 'string' ? data.sha : '';
      if (!ref.startsWith('refs/') || !isObjectId(sha) || !repo.objects.has(sha)) {
        fail(422, 'Validation Failed: ref and sha are required');
        return;
      }
      if (repo.refs.has(ref)) {
        fail(422, 'Reference already exists');
        return;
      }
      repo.refs.set(ref, sha);
      send(201, {
        ref,
        node_id: ForgeStore.globalId('G', `${repo.owner}/${repo.name}#${ref}`),
        url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${ref}`,
        object: { sha, type: objectType(repo, sha), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType(repo, sha)}s/${sha}` },
      });
      return;
    }
    fail(405, 'Method Not Allowed');
    return;
  }

  if (method !== 'GET') {
    fail(405, 'Method Not Allowed');
    return;
  }
  const refName = rest.join('/');
  const oid = repo.refs.get(refName);
  if (oid === undefined) {
    notFound();
    return;
  }
  send(200, {
    ref: refName,
    node_id: ForgeStore.globalId('G', `${repo.owner}/${repo.name}#${refName}`),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/refs/${refName}`,
    object: { sha: oid, type: objectType(repo, oid), url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${objectType(repo, oid)}s/${oid}` },
  });
}

// ---------------------------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------------------------

async function handleGit(
  req: IncomingMessage,
  res: ServerResponse,
  store: ForgeStore,
  segments: string[],
  headers: Record<string, string>,
): Promise<void> {
  const method = req.method ?? 'GET';
  const owner = segments[0] as string;
  const repoName = (segments[1] as string).slice(0, -'.git'.length);
  const rest = segments.slice(2);
  const fail = (status: number, message: string): void => sendJson(res, status, { message }, headers);

  // The token is opaque and names no login; a missing token is a 401, a
  // missing repository is a 404 on both services.
  if (bearerToken(req) === null) {
    fail(401, 'Requires authentication');
    return;
  }
  if (owner !== VIEWER.login) {
    fail(404, 'Not Found');
    return;
  }
  const repo = store.getRepo(repoName);
  if (!repo) {
    fail(404, 'Not Found');
    return;
  }
  const view = store.gitView(repo);

  // GET /info/refs?service=git-upload-pack|git-receive-pack
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = queryOf(req).get('service');
    const protocol = req.headers['git-protocol'];
    if (service === 'git-upload-pack') {
      const body = typeof protocol === 'string' && protocol.includes('version=2') ? advertisementV2() : advertisementV0(view, 'git-upload-pack');
      sendBuffer(res, 200, body, 'application/x-git-upload-pack-advertisement', headers);
      return;
    }
    if (service === 'git-receive-pack') {
      sendBuffer(res, 200, advertisementV0(view, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement', headers);
      return;
    }
    fail(400, 'service is required');
    return;
  }

  // POST /git-upload-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const raw = await readBody(req);
    const protocol = req.headers['git-protocol'];
    try {
      if (typeof protocol === 'string' && protocol.includes('version=2')) {
        const { command, args } = parseV2Command(raw);
        if (command === 'ls-refs') {
          sendBuffer(res, 200, handleLsRefs(view, args as { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }), 'application/x-git-upload-pack-result', headers);
          return;
        }
        if (command === 'fetch') {
          sendBuffer(res, 200, handleFetchV2(view, args as { wants: string[]; haves: string[]; shallowIn: string[]; depth: number | null }), 'application/x-git-upload-pack-result', headers);
          return;
        }
        fail(400, `unknown command ${command}`);
        return;
      }
      // v0: the body is want/have lines.
      const first = decodePktLines(raw).find((packet) => packet.kind === 'data');
      if (first && first.kind === 'data' && first.payload.toString('utf8').startsWith('command=')) {
        const { command, args } = parseV2Command(raw);
        if (command === 'ls-refs') {
          sendBuffer(res, 200, handleLsRefs(view, args as { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }), 'application/x-git-upload-pack-result', headers);
          return;
        }
        if (command === 'fetch') {
          sendBuffer(res, 200, handleFetchV2(view, args as { wants: string[]; haves: string[]; shallowIn: string[]; depth: number | null }), 'application/x-git-upload-pack-result', headers);
          return;
        }
        fail(400, `unknown command ${command}`);
        return;
      }
      sendBuffer(res, 200, handleFetchV0(view, parseV0Fetch(raw)), 'application/x-git-upload-pack-result', headers);
    } catch (err) {
      fail(400, err instanceof Error ? err.message : String(err));
    }
    return;
  }

  // POST /git-receive-pack
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const raw = await readBody(req);
    sendBuffer(res, 200, handleReceivePack(view, raw), 'application/x-git-receive-pack-result', headers);
    return;
  }

  fail(404, 'Not Found');
}
