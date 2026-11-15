// GraphQL over the same store the REST API uses: a hand-written parser and
// executor for exactly the documents the suite sends (operations, variables,
// aliases, inline fragments, fragment spreads, input objects, lists, enums,
// batched arrays), plus __type introspection. No dependency.
//
// Global ids are opaque but stable: base64 of "R:owner/name", "I:owner/name#n",
// "P:owner/name#n", "C:owner/name#issue/comment". A field the schema does not
// know answers HTTP 200 with an errors entry naming it, and the rest of the
// document still resolves; an unknown repository answers data.repository =
// null with no errors.

import { VIEWER } from './scenario.ts';
import { ForgeStore, isoTimestamp, type Repo, type Issue, type PullRequest } from './store.ts';
import { parseCommit } from './git.ts';

// ---------------------------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------------------------

type Value =
  | { readonly kind: 'variable'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'boolean'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly values: Value[] }
  | { readonly kind: 'object'; readonly fields: Map<string, Value> };

interface FieldSelection {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Map<string, Value>;
  readonly selections: Selection[] | null;
}
interface SpreadSelection {
  readonly kind: 'spread';
  readonly name: string;
}
interface InlineSelection {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selections: Selection[];
}
type Selection = FieldSelection | SpreadSelection | InlineSelection;

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly name: string | null;
  readonly variableDefaults: Map<string, Value>;
  readonly selections: Selection[];
}

interface Document {
  readonly operations: Operation[];
  readonly fragments: Map<string, Selection[]>;
}

class Parser {
  readonly #text: string;
  #pos = 0;
  constructor(text: string) {
    this.#text = text;
  }
  #peek(): string {
    return this.#text[this.#pos] ?? '';
  }
  #skipIgnored(): void {
    for (;;) {
      while (this.#pos < this.#text.length && /[\s,]/.test(this.#text[this.#pos] as string)) this.#pos += 1;
      if (this.#text[this.#pos] === '#') {
        while (this.#pos < this.#text.length && this.#text[this.#pos] !== '\n') this.#pos += 1;
        continue;
      }
      return;
    }
  }
  #expect(char: string): void {
    this.#skipIgnored();
    if (this.#text[this.#pos] !== char) throw new Error(`expected ${JSON.stringify(char)} at ${this.#pos}`);
    this.#pos += 1;
  }
  #consume(char: string): boolean {
    this.#skipIgnored();
    if (this.#text[this.#pos] === char) {
      this.#pos += 1;
      return true;
    }
    return false;
  }
  #readName(): string {
    this.#skipIgnored();
    const start = this.#pos;
    while (this.#pos < this.#text.length && /[_A-Za-z0-9]/.test(this.#text[this.#pos] as string)) this.#pos += 1;
    if (this.#pos === start) throw new Error(`expected a name at ${this.#pos}`);
    return this.#text.slice(start, this.#pos);
  }
  #peekName(): string | null {
    const saved = this.#pos;
    try {
      return this.#readName();
    } catch {
      return null;
    } finally {
      this.#pos = saved;
    }
  }
  #readString(): string {
    this.#skipIgnored();
    if (this.#text[this.#pos] !== '"') throw new Error(`expected a string at ${this.#pos}`);
    this.#pos += 1;
    let out = '';
    for (;;) {
      const ch = this.#text[this.#pos] as string;
      if (ch === undefined) throw new Error('unterminated string');
      if (ch === '"') {
        this.#pos += 1;
        return out;
      }
      if (ch === '\\') {
        const next = this.#text[this.#pos + 1] as string;
        const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (next === 'u') {
          out += String.fromCharCode(Number.parseInt(this.#text.slice(this.#pos + 2, this.#pos + 6), 16));
          this.#pos += 6;
        } else if (next in escapes) {
          out += escapes[next] as string;
          this.#pos += 2;
        } else {
          throw new Error(`bad escape \\${next}`);
        }
        continue;
      }
      out += ch;
      this.#pos += 1;
    }
  }
  #readValue(): Value {
    this.#skipIgnored();
    const ch = this.#peek();
    if (ch === '"') return { kind: 'string', value: this.#readString() };
    if (ch === '$') {
      this.#pos += 1;
      return { kind: 'variable', name: this.#readName() };
    }
    if (ch === '[') {
      this.#pos += 1;
      const values: Value[] = [];
      while (!this.#consume(']')) values.push(this.#readValue());
      return { kind: 'list', values };
    }
    if (ch === '{') {
      this.#pos += 1;
      const fields = new Map<string, Value>();
      while (!this.#consume('}')) {
        const name = this.#readName();
        this.#expect(':');
        fields.set(name, this.#readValue());
      }
      return { kind: 'object', fields };
    }
    if (ch === '-' || /[0-9]/.test(ch)) {
      const start = this.#pos;
      if (ch === '-') this.#pos += 1;
      while (/[0-9]/.test(this.#peek())) this.#pos += 1;
      let isFloat = false;
      if (this.#peek() === '.') {
        isFloat = true;
        this.#pos += 1;
        while (/[0-9]/.test(this.#peek())) this.#pos += 1;
      }
      if (this.#peek() === 'e' || this.#peek() === 'E') {
        isFloat = true;
        this.#pos += 1;
        if (this.#peek() === '+' || this.#peek() === '-') this.#pos += 1;
        while (/[0-9]/.test(this.#peek())) this.#pos += 1;
      }
      const raw = this.#text.slice(start, this.#pos);
      return isFloat ? { kind: 'float', value: Number.parseFloat(raw) } : { kind: 'int', value: Number.parseInt(raw, 10) };
    }
    const name = this.#readName();
    if (name === 'true') return { kind: 'boolean', value: true };
    if (name === 'false') return { kind: 'boolean', value: false };
    if (name === 'null') return { kind: 'null' };
    return { kind: 'enum', value: name };
  }
  #skipDirective(): void {
    this.#skipIgnored();
    if (this.#peek() !== '@') return;
    this.#pos += 1;
    this.#readName();
    this.#skipIgnored();
    if (this.#peek() === '(') {
      this.#pos += 1;
      while (!this.#consume(')')) {
        this.#readName();
        this.#expect(':');
        this.#readValue();
      }
    }
  }
  #readArguments(): Map<string, Value> {
    const args = new Map<string, Value>();
    this.#skipIgnored();
    if (this.#peek() !== '(') return args;
    this.#pos += 1;
    while (!this.#consume(')')) {
      const name = this.#readName();
      this.#expect(':');
      args.set(name, this.#readValue());
    }
    return args;
  }
  #readSelectionSet(): Selection[] {
    this.#expect('{');
    const selections: Selection[] = [];
    for (;;) {
      this.#skipIgnored();
      if (this.#consume('}')) return selections;
      if (this.#text.startsWith('...', this.#pos)) {
        this.#pos += 3;
        this.#skipIgnored();
        if (this.#text.startsWith('on ', this.#pos)) {
          this.#pos += 3;
          const typeCondition = this.#readName();
          selections.push({ kind: 'inline', typeCondition, selections: this.#readSelectionSet() });
        } else {
          const name = this.#readName();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      const first = this.#readName();
      let alias: string | null = null;
      let name = first;
      this.#skipIgnored();
      if (this.#peek() === ':') {
        this.#pos += 1;
        alias = first;
        name = this.#readName();
      }
      const args = this.#readArguments();
      this.#skipDirective();
      let sub: Selection[] | null = null;
      this.#skipIgnored();
      if (this.#peek() === '{') sub = this.#readSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selections: sub });
    }
  }
  parseDocument(): Document {
    const operations: Operation[] = [];
    const fragments = new Map<string, Selection[]>();
    for (;;) {
      this.#skipIgnored();
      if (this.#pos >= this.#text.length) break;
      if (this.#peek() === '{') {
        operations.push({ type: 'query', name: null, variableDefaults: new Map(), selections: this.#readSelectionSet() });
        continue;
      }
      const keyword = this.#readName();
      if (keyword === 'fragment') {
        const name = this.#readName();
        this.#skipIgnored();
        if (!this.#text.startsWith('on', this.#pos)) throw new Error('fragment without "on"');
        this.#pos += 2;
        this.#readName();
        fragments.set(name, this.#readSelectionSet());
        continue;
      }
      if (keyword !== 'query' && keyword !== 'mutation') throw new Error(`unknown document keyword ${keyword}`);
      let name: string | null = null;
      this.#skipIgnored();
      const maybeName = this.#peekName();
      if (maybeName !== null && this.#peek() !== '(' && this.#peek() !== '{') name = this.#readName();
      const variableDefaults = new Map<string, Value>();
      this.#skipIgnored();
      if (this.#peek() === '(') {
        this.#pos += 1;
        while (!this.#consume(')')) {
          this.#skipIgnored();
          if (this.#peek() === '$') this.#pos += 1;
          const varName = this.#readName();
          this.#expect(':');
          // The variable type: a name, possibly wrapped in [] and !.
          this.#skipIgnored();
          while (/[A-Za-z0-9_\[\]!]/.test(this.#peek())) this.#pos += 1;
          this.#skipIgnored();
          if (this.#peek() === '=') {
            this.#pos += 1;
            variableDefaults.set(varName, this.#readValue());
          }
        }
      }
      operations.push({ type: keyword, name, variableDefaults, selections: this.#readSelectionSet() });
    }
    if (operations.length === 0) throw new Error('document has no operation');
    return { operations, fragments };
  }
}

function resolveValue(value: Value, variables: ReadonlyMap<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable':
      return variables.get(value.name);
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return value.value;
    case 'null':
      return null;
    case 'enum':
      return value.value;
    case 'list':
      return value.values.map((item) => resolveValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of value.fields) out[key] = resolveValue(item, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------------------------

export function decodeGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function parseRepoKey(key: string): { owner: string; name: string } | null {
  const slash = key.indexOf('/');
  if (slash < 1) return null;
  return { owner: key.slice(0, slash), name: key.slice(slash + 1) };
}

// ---------------------------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------------------------

interface Ctx {
  readonly store: ForgeStore;
  readonly errors: Array<{ message: string }>;
  readonly fragments: Map<string, Selection[]>;
}

type AnyRecord = Record<string, unknown>;

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}
function indexOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return -1;
    const n = Number.parseInt(text.slice('cursor:'.length), 10);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

function paginate<T>(items: readonly T[], first: unknown, after: unknown): { nodes: T[]; pageInfo: AnyRecord } {
  const start = indexOfCursor(typeof after === 'string' ? after : null) + 1;
  const count = typeof first === 'number' && first >= 0 ? first : items.length;
  const nodes = items.slice(start, start + count);
  const endCursor = nodes.length > 0 ? cursorOf(start + nodes.length - 1) : null;
  return { nodes, pageInfo: { hasNextPage: start + count < items.length, endCursor } };
}

function userNode(login: string): AnyRecord {
  return { __typename: 'User', login, id: ForgeStore.globalId('U', login), name: login === VIEWER.login ? VIEWER.name : login };
}

function refNode(name: string): AnyRecord {
  return { __typename: 'Ref', name };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRequest): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueNode(store: ForgeStore, repo: Repo, issue: Issue): AnyRecord {
  return {
    __typename: 'Issue',
    id: ForgeStore.globalId('I', `${repo.owner}/${repo.name}#${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueState(issue),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    author: userNode(VIEWER.login),
    labels: { nodes: issue.labels.map((name) => ({ __typename: 'Label', name, color: repo.labels.find((label) => label.name === name)?.color ?? '000000', description: '' })) },
    comments: {
      nodes: issue.comments.map((comment) => ({
        __typename: 'IssueComment',
        id: ForgeStore.globalId('C', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
        body: comment.body,
        createdAt: comment.createdAt,
        author: userNode(comment.user),
      })),
    },
    repository: repoNode(store, repo),
  };
}

function fileChangeType(status: string): string {
  if (status === 'added') return 'ADDED';
  if (status === 'removed') return 'REMOVED';
  return 'MODIFIED';
}

function pullFiles(store: ForgeStore, repo: Repo, pull: PullRequest): AnyRecord[] {
  const headCommit = pull.headSha ? (repo.objects.get(pull.headSha) ?? null) : null;
  const baseCommit = pull.baseSha ? (repo.objects.get(pull.baseSha) ?? null) : null;
  if (!headCommit || headCommit.type !== 'commit' || !baseCommit || baseCommit.type !== 'commit') return [];
  const headTree = parseCommit(headCommit.data).tree;
  const baseTree = parseCommit(baseCommit.data).tree;
  const baseOfMerge = store.mergeBase(repo, pull.baseSha, pull.headSha);
  const mergeBaseTree = baseOfMerge === null ? null : parseCommit((repo.objects.get(baseOfMerge) as { data: Buffer }).data).tree;
  const changes = store.diffTrees(repo, mergeBaseTree, headTree);
  const baseFlat = store.flattenTree(repo, baseTree);
  const headFlat = store.flattenTree(repo, headTree);
  const files: AnyRecord[] = [];
  for (const [path, newOid] of changes) {
    const oldOid = baseFlat.get(path) ?? null;
    const status = newOid === null ? 'removed' : oldOid === null ? 'added' : 'modified';
    const countLines = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = repo.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text.length === 0) return 0;
      const lines = text.split('\n');
      return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    };
    const newLines = countLines(newOid);
    const oldLines = countLines(oldOid);
    const additions = status === 'added' ? newLines : Math.max(0, newLines - oldLines);
    const deletions = status === 'removed' ? oldLines : Math.max(0, oldLines - newLines);
    files.push({
      __typename: 'PullRequestFile',
      path,
      additions,
      deletions,
      changeType: fileChangeType(status),
      _headFlat: headFlat,
    });
  }
  files.sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return files;
}

function pullNode(store: ForgeStore, repo: Repo, pull: PullRequest): AnyRecord {
  return {
    __typename: 'PullRequest',
    id: ForgeStore.globalId('P', `${repo.owner}/${repo.name}#${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullState(pull),
    headRefName: pull.head,
    baseRefName: pull.base,
    headRefOid: pull.headSha,
    baseRefOid: pull.baseSha,
    mergeable: store.mergeConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE',
    merged: pull.merged,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
    author: userNode(VIEWER.login),
    repository: repoNode(store, repo),
    files: { nodes: pullFiles(store, repo, pull) },
  };
}

function repoNode(store: ForgeStore, repo: Repo): AnyRecord {
  return {
    __typename: 'Repository',
    id: ForgeStore.globalId('R', `${repo.owner}/${repo.name}`),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: userNode(repo.owner),
    defaultBranchRef: refNode(repo.defaultBranch),
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
    _repo: repo,
    _store: store,
  };
}

// ---------------------------------------------------------------------------------------------
// introspection
// ---------------------------------------------------------------------------------------------

interface TypeInfo {
  readonly kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  readonly fields?: string[];
  readonly enumValues?: string[];
  readonly inputFields?: string[];
}

const TYPE_TABLE: Readonly<Record<string, TypeInfo>> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'createdAt', 'updatedAt', 'author', 'repository', 'files'],
  },
  User: { kind: 'OBJECT', fields: ['id', 'login', 'name'] },
  Ref: { kind: 'OBJECT', fields: ['name'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  LabelEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER'] },
  RepositoryPermission: { kind: 'ENUM', enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
};

const SCALAR_TYPE_NAMES: Readonly<Record<string, string>> = {
  id: 'ID',
  databaseId: 'Int',
  number: 'Int',
  name: 'String',
  title: 'String',
  body: 'String',
  login: 'String',
  color: 'String',
  description: 'String',
  createdAt: 'DateTime',
  updatedAt: 'DateTime',
  state: 'String',
  headRefName: 'String',
  baseRefName: 'String',
  headRefOid: 'String',
  baseRefOid: 'String',
  mergeable: 'MergeableState',
  merged: 'Boolean',
  viewerPermission: 'RepositoryPermission',
  hasIssuesEnabled: 'Boolean',
  nameWithOwner: 'String',
  path: 'String',
  additions: 'Int',
  deletions: 'Int',
  changeType: 'String',
};

function typeInfoNode(name: string): AnyRecord {
  const info = TYPE_TABLE[name];
  const fields = (info?.fields ?? []).map((fieldName) => ({
    __typename: '__Field',
    name: fieldName,
    type: { __typename: '__Type', name: SCALAR_TYPE_NAMES[fieldName] ?? null, kind: SCALAR_TYPE_NAMES[fieldName] ? 'SCALAR' : 'OBJECT', ofType: null },
  }));
  return {
    __typename: '__Type',
    name,
    kind: info?.kind ?? 'OBJECT',
    description: null,
    fields: info?.fields ? fields : null,
    enumValues: info?.enumValues ? info.enumValues.map((value) => ({ __typename: '__EnumValue', name: value })) : null,
    inputFields: info?.inputFields ? info.inputFields.map((fieldName) => ({ __typename: '__InputValue', name: fieldName })) : null,
  };
}

// ---------------------------------------------------------------------------------------------
// field resolution
// ---------------------------------------------------------------------------------------------

function fieldTypeName(typeName: string, fieldName: string): string | null {
  const info = TYPE_TABLE[typeName];
  if (!info?.fields?.includes(fieldName)) return null;
  return fieldName;
}

function resolveSelectionSet(
  ctx: Ctx,
  typeName: string,
  source: AnyRecord,
  selections: readonly Selection[],
  variables: ReadonlyMap<string, unknown>,
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, resolveSelectionSet(ctx, typeName, source, fragment, variables));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== typeName && selection.typeCondition !== source.__typename) continue;
      Object.assign(out, resolveSelectionSet(ctx, typeName, source, selection.selections, variables));
      continue;
    }
    const key = selection.alias ?? selection.name;
    const value = resolveField(ctx, typeName, source, selection, variables);
    out[key] = value;
  }
  return out;
}

function resolveField(
  ctx: Ctx,
  typeName: string,
  source: AnyRecord,
  selection: FieldSelection,
  variables: ReadonlyMap<string, unknown>,
): unknown {
  const name = selection.name;
  // Introspection fields exist on every type.
  if (name === '__typename') return typeName;
  if (name === '__type') {
    const args = resolveArgs(selection.args, variables);
    const typeNameArg = args.name;
    if (typeof typeNameArg !== 'string') return null;
    return typeInfoNode(typeNameArg);
  }
  if (name === '__schema') {
    return {
      __typename: '__Schema',
      queryType: { __typename: '__Type', name: 'Query', kind: 'OBJECT' },
      mutationType: { __typename: '__Type', name: 'Mutation', kind: 'OBJECT' },
      types: Object.keys(TYPE_TABLE).map((typeNameItem) => typeInfoNode(typeNameItem)),
    };
  }
  if (fieldTypeName(typeName, name) === null) {
    ctx.errors.push({ message: `Cannot query field "${name}" on type "${typeName}".` });
    return null;
  }
  const args = resolveArgs(selection.args, variables);
  const sub = selection.selections;
  const store = ctx.store;

  const childType = (value: AnyRecord, fallback: string): string => (typeof value.__typename === 'string' ? value.__typename : fallback);
  const select = (value: AnyRecord | null, fallbackType: string): AnyRecord | null => {
    if (value === null || value === undefined) return null;
    if (!sub) return value;
    return resolveSelectionSet(ctx, childType(value, fallbackType), value, sub, variables);
  };
  const selectList = (values: AnyRecord[], fallbackType: string): AnyRecord[] => {
    if (!sub) return values;
    return values.map((value) => resolveSelectionSet(ctx, childType(value, fallbackType), value, sub, variables));
  };

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return select(userNode(VIEWER.login), 'User');
      if (name === 'repository') {
        const owner = args.owner;
        const repoName = args.name;
        if (typeof owner !== 'string' || typeof repoName !== 'string') return null;
        if (owner !== VIEWER.login) return null;
        const repo = store.getRepo(repoName);
        if (!repo) return null;
        return select(repoNode(store, repo), 'Repository');
      }
      if (name === 'node') {
        const id = args.id;
        if (typeof id !== 'string') return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'R') {
          const key = parseRepoKey(decoded.key);
          if (!key || key.owner !== VIEWER.login) return null;
          const repo = store.getRepo(key.name);
          if (!repo) return null;
          return select(repoNode(store, repo), 'Repository');
        }
        if (decoded.kind === 'I') {
          const hash = decoded.key.lastIndexOf('#');
          if (hash < 0) return null;
          const key = parseRepoKey(decoded.key.slice(0, hash));
          const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
          if (!key || key.owner !== VIEWER.login || !Number.isFinite(number)) return null;
          const repo = store.getRepo(key.name);
          const issue = repo?.issues.find((item) => item.number === number);
          if (!repo || !issue) return null;
          return select(issueNode(store, repo, issue), 'Issue');
        }
        if (decoded.kind === 'P') {
          const hash = decoded.key.lastIndexOf('#');
          if (hash < 0) return null;
          const key = parseRepoKey(decoded.key.slice(0, hash));
          const number = Number.parseInt(decoded.key.slice(hash + 1), 10);
          if (!key || key.owner !== VIEWER.login || !Number.isFinite(number)) return null;
          const repo = store.getRepo(key.name);
          const pull = repo?.pulls.find((item) => item.number === number);
          if (!repo || !pull) return null;
          return select(pullNode(store, repo, pull), 'PullRequest');
        }
        return null;
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, name, args, sub, variables);
    }
    case 'Repository': {
      const repo = source._repo as Repo | undefined;
      if (!repo) return null;
      if (name === 'issue') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const issue = repo.issues.find((item) => item.number === number);
        return issue ? select(issueNode(store, repo, issue), 'Issue') : null;
      }
      if (name === 'issues') {
        let items = [...repo.issues];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          items = items.filter((issue) => wanted.has(issueState(issue)));
        }
        const orderBy = args.orderBy as AnyRecord | undefined;
        const direction = String(orderBy?.direction ?? 'DESC').toUpperCase();
        items.sort((a, b) => (direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
        const page = paginate(items, args.first, args.after);
        return select(
          {
            __typename: 'IssueConnection',
            nodes: page.nodes.map((issue) => issueNode(store, repo, issue)),
            edges: page.nodes.map((issue, index) => ({ __typename: 'IssueEdge', node: issueNode(store, repo, issue), cursor: cursorOf(index) })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: page.pageInfo.endCursor },
            totalCount: items.length,
          },
          'IssueConnection',
        );
      }
      if (name === 'pullRequest') {
        const number = args.number;
        if (typeof number !== 'number') return null;
        const pull = repo.pulls.find((item) => item.number === number);
        return pull ? select(pullNode(store, repo, pull), 'PullRequest') : null;
      }
      if (name === 'pullRequests') {
        let items = [...repo.pulls];
        const states = args.states;
        if (Array.isArray(states) && states.length > 0) {
          const wanted = new Set(states.map((state) => String(state).toUpperCase()));
          items = items.filter((pull) => wanted.has(pullState(pull)));
        }
        items.sort((a, b) => b.createdSeq - a.createdSeq);
        const page = paginate(items, args.first, args.after);
        return select(
          {
            __typename: 'PullRequestConnection',
            nodes: page.nodes.map((pull) => pullNode(store, repo, pull)),
            edges: page.nodes.map((pull, index) => ({ __typename: 'PullRequestEdge', node: pullNode(store, repo, pull), cursor: cursorOf(index) })),
            pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: page.pageInfo.endCursor },
            totalCount: items.length,
          },
          'PullRequestConnection',
        );
      }
      if (name === 'owner') return select(userNode(repo.owner), 'User');
      if (name === 'defaultBranchRef') return select(refNode(repo.defaultBranch), 'Ref');
      return (source as AnyRecord)[name] ?? null;
    }
    case 'Issue': {
      if (name === 'labels') {
        const repo = (source.repository as AnyRecord | undefined)?._repo as Repo | undefined;
        const nodes = (source.labels as AnyRecord | undefined)?.nodes as AnyRecord[] | undefined;
        if (nodes) return select({ __typename: 'LabelConnection', nodes, edges: nodes.map((node, index) => ({ __typename: 'LabelEdge', node, cursor: cursorOf(index) })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: nodes.length }, 'LabelConnection');
        return select({ __typename: 'LabelConnection', nodes: [], edges: [], pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 }, 'LabelConnection');
      }
      if (name === 'comments') {
        const nodes = (source.comments as AnyRecord | undefined)?.nodes as AnyRecord[] | undefined;
        const list = nodes ?? [];
        return select({ __typename: 'IssueCommentConnection', nodes: list, edges: list.map((node, index) => ({ __typename: 'IssueCommentEdge', node, cursor: cursorOf(index) })), pageInfo: { __typename: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: list.length }, 'IssueCommentConnection');
      }
      if (name === 'author') return select(source.author as AnyRecord, 'User');
      if (name === 'repository') {
        const repoRecord = source.repository as AnyRecord | undefined;
        return repoRecord ? select(repoRecord, 'Repository') : null;
      }
      return (source as AnyRecord)[name] ?? null;
    }
    case 'PullRequest': {
      if (name === 'files') {
        const nodes = (source.files as AnyRecord | undefined)?.nodes as AnyRecord[] | undefined;
        const list = nodes ?? [];
        const page = paginate(list, args.first, args.after);
        return select({ __typename: 'PullRequestFileConnection', nodes: page.nodes, edges: page.nodes.map((node, index) => ({ __typename: 'PullRequestFileEdge', node, cursor: cursorOf(index) })), pageInfo: { __typename: 'PageInfo', hasNextPage: page.pageInfo.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: page.pageInfo.endCursor }, totalCount: list.length }, 'PullRequestFileConnection');
      }
      if (name === 'author') return select(source.author as AnyRecord, 'User');
      if (name === 'repository') {
        const repoRecord = source.repository as AnyRecord | undefined;
        return repoRecord ? select(repoRecord, 'Repository') : null;
      }
      return (source as AnyRecord)[name] ?? null;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'LabelConnection':
    case 'IssueCommentConnection':
    case 'PullRequestFileConnection': {
      if (name === 'nodes') return selectList((source.nodes as AnyRecord[]) ?? [], typeName.replace('Connection', ''));
      if (name === 'edges') {
        const edges = (source.edges as AnyRecord[]) ?? [];
        if (!sub) return edges;
        return edges.map((edge) => resolveSelectionSet(ctx, typeName.replace('Connection', 'Edge'), edge, sub, variables));
      }
      if (name === 'pageInfo') {
        const pageInfo = source.pageInfo as AnyRecord | undefined;
        if (!pageInfo) return null;
        return sub ? resolveSelectionSet(ctx, 'PageInfo', pageInfo, sub, variables) : pageInfo;
      }
      if (name === 'totalCount') return source.totalCount ?? null;
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'LabelEdge':
    case 'IssueCommentEdge':
    case 'PullRequestFileEdge': {
      if (name === 'node') {
        const node = source.node as AnyRecord | undefined;
        if (!node) return null;
        const nodeType = childType(node, typeName.replace('Edge', ''));
        return sub ? resolveSelectionSet(ctx, nodeType, node, sub, variables) : node;
      }
      if (name === 'cursor') return source.cursor ?? null;
      return null;
    }
    case 'PageInfo':
      return (source as AnyRecord)[name] ?? null;
    case 'User':
    case 'Ref':
    case 'Label':
    case 'IssueComment':
    case 'PullRequestFile':
      return (source as AnyRecord)[name] ?? null;
    case '__Type': {
      if (name === 'fields') {
        const fields = source.fields as AnyRecord[] | null;
        if (fields === null || fields === undefined) return null;
        if (!sub) return fields;
        return fields.map((field) => resolveSelectionSet(ctx, '__Field', field, sub, variables));
      }
      if (name === 'enumValues') {
        const values = source.enumValues as AnyRecord[] | null;
        if (values === null || values === undefined) return null;
        if (!sub) return values;
        return values.map((value) => resolveSelectionSet(ctx, '__EnumValue', value, sub, variables));
      }
      if (name === 'inputFields') {
        const fields = source.inputFields as AnyRecord[] | null;
        if (fields === null || fields === undefined) return null;
        if (!sub) return fields;
        return fields.map((field) => resolveSelectionSet(ctx, '__InputValue', field, sub, variables));
      }
      if (name === 'ofType') {
        const ofType = source.ofType as AnyRecord | null;
        if (ofType === null || ofType === undefined) return null;
        return sub ? resolveSelectionSet(ctx, '__Type', ofType, sub, variables) : ofType;
      }
      return (source as AnyRecord)[name] ?? null;
    }
    case '__Field':
    case '__EnumValue':
    case '__InputValue': {
      if (name === 'type') {
        const type = source.type as AnyRecord | undefined;
        if (!type) return null;
        return sub ? resolveSelectionSet(ctx, '__Type', type, sub, variables) : type;
      }
      return (source as AnyRecord)[name] ?? null;
    }
    case '__Schema': {
      if (name === 'queryType' || name === 'mutationType') {
        const type = source[name] as AnyRecord | undefined;
        if (!type) return null;
        return sub ? resolveSelectionSet(ctx, '__Type', type, sub, variables) : type;
      }
      if (name === 'types') {
        const types = (source.types as AnyRecord[]) ?? [];
        if (!sub) return types;
        return types.map((type) => resolveSelectionSet(ctx, '__Type', type, sub, variables));
      }
      return null;
    }
    default: {
      const value = (source as AnyRecord)[name] ?? null;
      if (value === null || value === undefined) return null;
      if (typeof value === 'object' && !Array.isArray(value)) return select(value as AnyRecord, typeName);
      return value;
    }
  }
}

function resolveArgs(args: ReadonlyMap<string, Value>, variables: ReadonlyMap<string, unknown>): AnyRecord {
  const out: AnyRecord = {};
  for (const [key, value] of args) out[key] = resolveValue(value, variables);
  return out;
}

function resolveMutation(
  ctx: Ctx,
  name: string,
  args: AnyRecord,
  sub: Selection[] | null,
  variables: ReadonlyMap<string, unknown>,
): unknown {
  const store = ctx.store;
  const input = (args.input ?? {}) as AnyRecord;
  const select = (value: AnyRecord | null, fallbackType: string): AnyRecord | null => {
    if (value === null) return null;
    if (!sub) return value;
    return resolveSelectionSet(ctx, fallbackType, value, sub, variables);
  };

  if (name === 'createIssue') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const key = decoded?.kind === 'R' ? parseRepoKey(decoded.key) : null;
    const repo = key && key.owner === VIEWER.login ? store.getRepo(key.name) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
      return select({ __typename: 'CreateIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null }, 'CreateIssuePayload');
    }
    const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
    return select({ __typename: 'CreateIssuePayload', issue: issueNode(store, repo, issue), clientMutationId: input.clientMutationId ?? null }, 'CreateIssuePayload');
  }
  if (name === 'closeIssue') {
    const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    let issue: Issue | undefined;
    let repo: Repo | undefined;
    if (decoded?.kind === 'I') {
      const hash = decoded.key.lastIndexOf('#');
      const key = hash >= 0 ? parseRepoKey(decoded.key.slice(0, hash)) : null;
      const number = hash >= 0 ? Number.parseInt(decoded.key.slice(hash + 1), 10) : Number.NaN;
      if (key && key.owner === VIEWER.login && Number.isFinite(number)) {
        repo = store.getRepo(key.name);
        issue = repo?.issues.find((item) => item.number === number);
      }
    }
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id provided.' });
      return select({ __typename: 'CloseIssuePayload', issue: null, clientMutationId: input.clientMutationId ?? null }, 'CloseIssuePayload');
    }
    issue.state = 'closed';
    issue.updatedAt = isoTimestamp(store.nextSeq());
    return select({ __typename: 'CloseIssuePayload', issue: issueNode(store, repo, issue), clientMutationId: input.clientMutationId ?? null }, 'CloseIssuePayload');
  }
  if (name === 'createPullRequest') {
    const decoded = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const key = decoded?.kind === 'R' ? parseRepoKey(decoded.key) : null;
    const repo = key && key.owner === VIEWER.login ? store.getRepo(key.name) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the global id provided.' });
      return select({ __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null }, 'CreatePullRequestPayload');
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    if (!repo.refs.has(`refs/heads/${head}`) || !repo.refs.has(`refs/heads/${base}`)) {
      ctx.errors.push({ message: `No such branch: ${head} or ${base}.` });
      return select({ __typename: 'CreatePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null }, 'CreatePullRequestPayload');
    }
    const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
    return select({ __typename: 'CreatePullRequestPayload', pullRequest: pullNode(store, repo, pull), clientMutationId: input.clientMutationId ?? null }, 'CreatePullRequestPayload');
  }
  if (name === 'mergePullRequest') {
    const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    let pull: PullRequest | undefined;
    let repo: Repo | undefined;
    if (decoded?.kind === 'P') {
      const hash = decoded.key.lastIndexOf('#');
      const key = hash >= 0 ? parseRepoKey(decoded.key.slice(0, hash)) : null;
      const number = hash >= 0 ? Number.parseInt(decoded.key.slice(hash + 1), 10) : Number.NaN;
      if (key && key.owner === VIEWER.login && Number.isFinite(number)) {
        repo = store.getRepo(key.name);
        pull = repo?.pulls.find((item) => item.number === number);
      }
    }
    if (!repo || !pull) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id provided.' });
      return select({ __typename: 'MergePullRequestPayload', pullRequest: null, clientMutationId: input.clientMutationId ?? null }, 'MergePullRequestPayload');
    }
    if (pull.state !== 'open') {
      ctx.errors.push({ message: 'Pull request is not open.' });
      return select({ __typename: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull), clientMutationId: input.clientMutationId ?? null }, 'MergePullRequestPayload');
    }
    const sha = store.squashMerge(repo, pull);
    if (sha === null) {
      ctx.errors.push({ message: 'Merge conflict.' });
      return select({ __typename: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull), clientMutationId: input.clientMutationId ?? null }, 'MergePullRequestPayload');
    }
    pull.merged = true;
    pull.mergeCommitSha = sha;
    pull.mergedAt = isoTimestamp(store.nextSeq());
    pull.state = 'closed';
    pull.updatedAt = pull.mergedAt;
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    return select({ __typename: 'MergePullRequestPayload', pullRequest: pullNode(store, repo, pull), clientMutationId: input.clientMutationId ?? null }, 'MergePullRequestPayload');
  }
  if (name === 'addComment') {
    const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    let issue: Issue | undefined;
    let repo: Repo | undefined;
    if (decoded?.kind === 'I') {
      const hash = decoded.key.lastIndexOf('#');
      const key = hash >= 0 ? parseRepoKey(decoded.key.slice(0, hash)) : null;
      const number = hash >= 0 ? Number.parseInt(decoded.key.slice(hash + 1), 10) : Number.NaN;
      if (key && key.owner === VIEWER.login && Number.isFinite(number)) {
        repo = store.getRepo(key.name);
        issue = repo?.issues.find((item) => item.number === number);
      }
    }
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the global id provided.' });
      return select({ __typename: 'AddCommentPayload', commentEdge: null, clientMutationId: input.clientMutationId ?? null }, 'AddCommentPayload');
    }
    const comment = store.addComment(repo, issue, String(input.body ?? ''));
    const node: AnyRecord = {
      __typename: 'IssueComment',
      id: ForgeStore.globalId('C', `${repo.owner}/${repo.name}#${issue.number}/${comment.id}`),
      body: comment.body,
      createdAt: comment.createdAt,
      author: userNode(comment.user),
    };
    return select({ __typename: 'AddCommentPayload', commentEdge: { __typename: 'IssueCommentEdge', node, cursor: cursorOf(issue.comments.length - 1) }, clientMutationId: input.clientMutationId ?? null }, 'AddCommentPayload');
  }
  ctx.errors.push({ message: `Cannot query field "${name}" on type "Mutation".` });
  return null;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResult {
  readonly status: number;
  readonly body: unknown;
}

function executeOne(store: ForgeStore, documentText: string, variables: Record<string, unknown> | null, operationName: string | null): GraphQLResult {
  const errors: Array<{ message: string }> = [];
  let document: Document;
  try {
    document = new Parser(documentText).parseDocument();
  } catch (err) {
    return { status: 400, body: { errors: [{ message: err instanceof Error ? err.message : String(err) }] } };
  }
  const operation = operationName !== null ? document.operations.find((item) => item.name === operationName) : document.operations[0];
  if (!operation) return { status: 400, body: { errors: [{ message: `Unknown operation named "${operationName}".` }] } };
  const variableValues = new Map<string, unknown>();
  for (const [key, value] of Object.entries(variables ?? {})) variableValues.set(key, value);
  for (const [key, defaultValue] of operation.variableDefaults) {
    if (!variableValues.has(key)) variableValues.set(key, resolveValue(defaultValue, variableValues));
  }
  const ctx: Ctx = { store, errors, fragments: document.fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = resolveSelectionSet(ctx, rootType, {}, operation.selections, variableValues);
  const body: AnyRecord = { data };
  if (errors.length > 0) body.errors = errors;
  return { status: 200, body };
}

/** Handle one GraphQL request body (a single document, or an array for batches). */
export function handleGraphQL(store: ForgeStore, body: unknown): GraphQLResult {
  if (Array.isArray(body)) {
    const results = body.map((item) => {
      const entry = (item ?? {}) as AnyRecord;
      if (typeof entry.query !== 'string') return { status: 400, body: { errors: [{ message: 'Each batched operation needs a query string.' }] } };
      return executeOne(store, entry.query, (entry.variables ?? null) as Record<string, unknown> | null, typeof entry.operationName === 'string' ? entry.operationName : null);
    });
    return { status: 200, body: results.map((result) => result.body) };
  }
  const entry = (body ?? {}) as AnyRecord;
  if (typeof entry.query !== 'string') return { status: 400, body: { errors: [{ message: 'Request needs a query string.' }] } };
  return executeOne(store, entry.query, (entry.variables ?? null) as Record<string, unknown> | null, typeof entry.operationName === 'string' ? entry.operationName : null);
}
