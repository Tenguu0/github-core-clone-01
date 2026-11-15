// The MCP endpoint (Streamable HTTP, era 2026-07-28): server/discover plus
// the legacy initialize handshake, tools/list and tools/call over the same
// store the REST API uses. No session id is ever issued, so no session is
// ever closed; every request is stateless.
//
// Tools (six, the suite's documented set): create_repo, get_repo,
// create_issue, list_issues, create_pull_request, merge_pull_request. Each
// tool takes the documented names and their common synonyms (owner_login,
// full_name="owner/repo", head_ref, pull_number/number), and every effect is
// visible over REST with the same ids.

import { VIEWER } from './scenario.ts';
import { ForgeStore, isoTimestamp, type Repo } from './store.ts';

const PROTOCOL_VERSION = '2026-07-28';
const KNOWN_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'forge', version: '1.0.0' };

export interface McpOutcome {
  /** HTTP status: 200 for a JSON-RPC result/error, 202 for a notification, 400 for a parse error. */
  readonly status: number;
  /** The JSON-RPC body, or null for a 202 notification (empty body). */
  readonly body: unknown;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        repo: { type: 'string', description: 'Repository name.' },
        name: { type: 'string', description: 'Repository name (alias of repo).' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
        labels: { type: 'string', description: 'Comma-separated label names.' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        state: { type: 'string', description: 'Issue state filter: open, closed or all.' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        head_ref: { type: 'string', description: 'Head branch name (alias of head).' },
        base: { type: 'string', description: 'Base branch name.' },
        base_ref: { type: 'string', description: 'Base branch name (alias of base).' },
      },
      required: ['repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login; defaults to the viewer.' },
        repo: { type: 'string', description: 'Repository name.' },
        full_name: { type: 'string', description: 'Full name "owner/repo".' },
        pull_number: { type: 'number', description: 'Pull request number.' },
        number: { type: 'number', description: 'Pull request number (alias of pull_number).' },
        merge_method: { type: 'string', description: 'Merge method: squash.' },
      },
      required: ['repo', 'pull_number'],
    },
  },
];

function toolResult(data: unknown): Record<string, unknown> {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Resolve owner/repo from the documented names and their synonyms. */
function resolveRepoRef(args: Record<string, unknown>): { owner: string; repo: string } {
  const fullName = args.full_name ?? args.fullName;
  if (typeof fullName === 'string' && fullName.includes('/')) {
    const [owner, repo] = fullName.split('/', 2) as [string, string];
    return { owner, repo };
  }
  const owner = typeof args.owner === 'string' && args.owner.length > 0 ? args.owner : typeof args.owner_login === 'string' && args.owner_login.length > 0 ? args.owner_login : VIEWER.login;
  const repo = typeof args.repo === 'string' && args.repo.length > 0 ? args.repo : typeof args.name === 'string' ? args.name : '';
  return { owner, repo };
}

function findRepo(store: ForgeStore, args: Record<string, unknown>): Repo | null {
  const ref = resolveRepoRef(args);
  if (ref.owner !== VIEWER.login) return null;
  return store.getRepo(ref.repo) ?? null;
}

function repoSummary(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: ForgeStore.globalId('U', repo.owner) },
    description: repo.description,
    private: repo.isPrivate,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
}

function callTool(store: ForgeStore, name: string, args: Record<string, unknown>): { error?: { code: number; message: string }; result?: Record<string, unknown> } {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return { error: { code: -32601, message: `Method not found: ${name}` } };
  // A required property the caller cannot fill is an isError answer, not an exception.
  const missing = tool.inputSchema.required.filter((key) => {
    if (key === 'repo') return resolveRepoRef(args).repo === '';
    if (key === 'head') return typeof args.head !== 'string' && typeof args.head_ref !== 'string';
    if (key === 'base') return typeof args.base !== 'string' && typeof args.base_ref !== 'string';
    if (key === 'pull_number') return typeof args.pull_number !== 'number' && typeof args.number !== 'number';
    return args[key] === undefined || args[key] === null || args[key] === '';
  });
  if (missing.length > 0) {
    return { result: toolError(`Missing required argument(s): ${missing.join(', ')}`) };
  }

  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const owner = typeof args.owner === 'string' && args.owner.length > 0 ? args.owner : VIEWER.login;
      if (owner !== VIEWER.login) return { result: toolError(`Cannot create a repository for owner ${owner}.`) };
      if (store.getRepo(repoName)) return { result: toolError(`Repository ${repoName} already exists.`) };
      const repo = store.createRepo(repoName, typeof args.description === 'string' ? args.description : '', args.private === true);
      return { result: toolResult(repoSummary(repo)) };
    }
    case 'get_repo': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolError('Repository not found.') };
      return { result: toolResult(repoSummary(repo)) };
    }
    case 'create_issue': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolError('Repository not found.') };
      const labelsRaw = typeof args.labels === 'string' ? args.labels : Array.isArray(args.labels) ? args.labels.join(',') : '';
      const labels = labelsRaw.split(',').map((label) => label.trim()).filter((label) => label.length > 0);
      for (const label of labels) {
        if (!repo.labels.some((known) => known.name === label)) return { result: toolError(`Unknown label: ${label}`) };
      }
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', labels);
      return {
        result: toolResult({
          id: ForgeStore.globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          labels: issue.labels,
          user: { login: VIEWER.login },
          created_at: issue.createdAt,
          updated_at: issue.updatedAt,
        }),
      };
    }
    case 'list_issues': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolError('Repository not found.') };
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((issue) => state === 'all' || issue.state === state);
      return {
        result: toolResult(
          issues.map((issue) => ({
            id: ForgeStore.globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state,
            labels: issue.labels,
            user: { login: VIEWER.login },
            created_at: issue.createdAt,
            updated_at: issue.updatedAt,
          })),
        ),
      };
    }
    case 'create_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolError('Repository not found.') };
      const head = typeof args.head === 'string' ? args.head : String(args.head_ref);
      const base = typeof args.base === 'string' ? args.base : String(args.base_ref);
      if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
        return { result: toolError(`No such branch: ${head} or ${base}.`) };
      }
      const pull = store.createPull(repo, String(args.title), typeof args.body === 'string' ? args.body : '', head, base);
      return {
        result: toolResult({
          id: ForgeStore.globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: pull.head, sha: pull.headSha },
          base: { ref: pull.base, sha: pull.baseSha },
          merged: pull.merged,
          created_at: pull.createdAt,
          updated_at: pull.updatedAt,
        }),
      };
    }
    case 'merge_pull_request': {
      const repo = findRepo(store, args);
      if (!repo) return { result: toolError('Repository not found.') };
      const number = typeof args.pull_number === 'number' ? args.pull_number : (args.number as number);
      const pull = repo.pulls.find((item) => item.number === number);
      if (!pull) return { result: toolError(`Pull request #${number} not found.`) };
      if (pull.state !== 'open') return { result: toolError(`Pull request #${number} is not open.`) };
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return { result: toolError('Merge conflict.') };
      pull.merged = true;
      pull.mergeCommitSha = sha;
      pull.mergedAt = isoTimestamp(store.nextSeq());
      pull.state = 'closed';
      pull.updatedAt = pull.mergedAt;
      repo.refs.set(`refs/heads/${pull.base}`, sha);
      return {
        result: toolResult({
          id: ForgeStore.globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
          number: pull.number,
          title: pull.title,
          state: pull.state,
          merged: true,
          merge_commit_sha: sha,
          merged_at: pull.mergedAt,
          sha,
          message: `Merge pull request #${pull.number}`,
        }),
      };
    }
    default:
      return { error: { code: -32601, message: `Method not found: ${name}` } };
  }
}

/**
 * Handle one MCP request. `rawBody` is the request bytes as received; a body
 * that is not JSON is a parse error (HTTP 400, code -32700). `authorized` is
 * false when no bearer token was sent, which is a 401 for every method.
 */
export function handleMcp(store: ForgeStore, rawBody: Buffer, authorized: boolean): McpOutcome {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('not an object');
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const id = 'id' in request ? request.id : undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;
  // A notification (no id) is answered 202 with an empty body.
  if (id === undefined) {
    return { status: 202, body: null };
  }
  const error = (code: number, message: string): McpOutcome => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });
  const result = (value: unknown, meta?: Record<string, unknown>): McpOutcome => {
    const body: Record<string, unknown> = { jsonrpc: '2.0', id, result: value };
    if (meta) body._meta = meta;
    return { status: 200, body };
  };
  if (!authorized) {
    return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32000, message: 'Unauthorized' } } };
  }
  if (method === 'server/discover') {
    return result(
      { protocolVersion: PROTOCOL_VERSION, supportedVersions: KNOWN_VERSIONS, capabilities: { tools: {} }, serverInfo: SERVER_INFO },
      { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    );
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const version = KNOWN_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return result({ protocolVersion: version, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (method === 'tools/list') {
    return result({ tools: TOOLS });
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const outcome = callTool(store, toolName, args);
    if (outcome.error) return error(outcome.error.code, outcome.error.message);
    return result(outcome.result ?? {});
  }
  if (method === 'ping') {
    return result({});
  }
  return error(-32601, `Method not found: ${method}`);
}
