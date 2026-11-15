// The forge's data model: repositories, issues, pull requests, labels and
// comments, plus the git object store and the commit machinery behind the
// contents API and squash merges.
//
// Determinism is a scored property: two runs of the same trial must export
// the same state byte-for-byte, so nothing here reads the wall clock. Every
// timestamp is derived from a single monotonic sequence counter over a fixed
// base epoch, and every identifier the forge mints (request ids, commit
// stamps) comes from that same counter. Commit SHAs are content-only, so a
// replayed history hashes identically.

import { VIEWER, DEFAULT_BRANCH } from './scenario.ts';
import {
  hashObject,
  parseCommit,
  parseTree,
  buildTree,
  peelToCommit,
  collectReachable,
  type GitObject,
  type GitObjectType,
  type GitRepoView,
  type TreeEntry,
} from './git.ts';

/** Fixed base epoch for every timestamp the forge emits (a real, sane date). */
const BASE_EPOCH_SECONDS = 1_700_000_000;
/** RFC 2822 date line for the viewer, from the deterministic counter. */
export function authorLine(seq: number): string {
  return `${VIEWER.name} <${VIEWER.email}> ${BASE_EPOCH_SECONDS + seq} +0000`;
}
/** The ISO timestamp the REST API returns for a given sequence number. */
export function isoTimestamp(seq: number): string {
  return new Date((BASE_EPOCH_SECONDS + seq) * 1000).toISOString();
}

export interface Label {
  readonly name: string;
  readonly color: string;
  readonly description: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  readonly number: number;
  title: string;
  body: string;
  state: IssueState;
  labels: string[];
  comments: Comment[];
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export type PullState = 'open' | 'closed';

export interface PullRequest {
  readonly number: number;
  title: string;
  body: string;
  state: PullState;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergeCommitSha: string | null;
  mergedAt: string | null;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface Repo {
  readonly id: number;
  readonly name: string;
  readonly owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  nextIssueNumber: number;
  nextPullNumber: number;
  nextCommentId: number;
  /** Git objects by oid. */
  readonly objects: Map<string, GitObject>;
  /** Refs by full name, e.g. refs/heads/main. */
  readonly refs: Map<string, string>;
  readonly createdAt: string;
  updatedAt: string;
  readonly createdSeq: number;
}

export interface PullFileChange {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

export class ForgeStore {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  /** Monotonic counter: the only source of "time" in the whole forge. */
  private seq = 0;

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An opaque, stable global id: base64 of a namespaced key. */
  static globalId(kind: string, key: string): string {
    return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
  }

  /** The git view of one repository, for the protocol layer. */
  gitView(repo: Repo): GitRepoView {
    return {
      defaultBranch: repo.defaultBranch,
      getObject: (oid) => repo.objects.get(oid),
      putObject: (type, data) => this.putObject(repo, type, data),
      getRef: (name) => repo.refs.get(name),
      setRef: (name, oid) => {
        repo.refs.set(name, oid);
      },
      deleteRef: (name) => {
        repo.refs.delete(name);
      },
      listRefs: () =>
        [...repo.refs.entries()]
          .map(([name, oid]) => ({ name, oid }))
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    };
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const seq = this.nextSeq();
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: VIEWER.login,
      description,
      isPrivate,
      defaultBranch: DEFAULT_BRANCH,
      labels: [
        { name: 'bug', color: 'd73a4a', description: "Something isn't working" },
        { name: 'enhancement', color: 'a2eeef', description: 'New feature or request' },
        { name: 'documentation', color: '0075ca', description: 'Improvements or additions to documentation' },
        { name: 'question', color: 'd876e3', description: 'Further information is requested' },
        { name: 'good first issue', color: '7057ff', description: 'Good for newcomers' },
        { name: 'help wanted', color: '008672', description: 'Extra attention is needed' },
      ],
      issues: [],
      pulls: [],
      nextIssueNumber: 1,
      nextPullNumber: 1,
      nextCommentId: 1,
      objects: new Map<string, GitObject>(),
      refs: new Map<string, string>(),
      createdAt: isoTimestamp(seq),
      updatedAt: isoTimestamp(seq),
      createdSeq: seq,
    };
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }

  // ---------------------------------------------------------------------------
  // issues / pulls
  // ---------------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const seq = this.nextSeq();
    const issue: Issue = {
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: isoTimestamp(seq),
      updatedAt: isoTimestamp(seq),
      createdSeq: seq,
    };
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const seq = this.nextSeq();
    const comment: Comment = {
      id: repo.nextCommentId,
      body,
      user: VIEWER.login,
      createdAt: isoTimestamp(seq),
      updatedAt: isoTimestamp(seq),
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest {
    const seq = this.nextSeq();
    const headSha = repo.refs.get(`refs/heads/${head}`) ?? '';
    const baseSha = repo.refs.get(`refs/heads/${base}`) ?? '';
    const pull: PullRequest = {
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      createdAt: isoTimestamp(seq),
      updatedAt: isoTimestamp(seq),
      createdSeq: seq,
    };
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  // ---------------------------------------------------------------------------
  // commits, trees and the contents API
  // ---------------------------------------------------------------------------

  /** The flat path -> blob-oid map of a tree, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, string> {
    const out = new Map<string, string>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue; // gitlink: not followed
        if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
        else out.set(`${prefix}${entry.name}`, entry.oid);
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Rebuild a tree from a flat path -> blob-oid map, storing every node. */
  buildTreeFromFlat(repo: Repo, flat: Map<string, string>): string {
    type TreeMap = Map<string, string | TreeMap>;
    const root: TreeMap = new Map();
    for (const [path, oid] of flat) {
      const segments = path.split('/');
      let node: TreeMap = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const segment = segments[i] as string;
        let child = node.get(segment);
        if (!(child instanceof Map)) {
          child = new Map();
          node.set(segment, child);
        }
        node = child;
      }
      node.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: TreeMap): string => {
      const entries: TreeEntry[] = [];
      for (const [name, value] of node) {
        if (value instanceof Map) entries.push({ mode: '40000', name, oid: build(value) });
        else entries.push({ mode: '100644', name, oid: value });
      }
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** Create a commit object for `treeOid` on top of `parents` and store it. */
  createCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
    const seq = this.nextSeq();
    const stamp = authorLine(seq);
    const lines = [`tree ${treeOid}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${stamp}`, `committer ${stamp}`, '', message);
    return this.putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  /** The merge-base of two commits: the first common ancestor by commit-time order. */
  mergeBase(repo: Repo, left: string, right: string): string | null {
    if (left === right) return left;
    const leftAncestors = new Set<string>();
    const queue: string[] = [left];
    while (queue.length) {
      const current = queue.pop() as string;
      if (leftAncestors.has(current)) continue;
      leftAncestors.add(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    const rightQueue: string[] = [right];
    const seen = new Set<string>();
    while (rightQueue.length) {
      const current = rightQueue.shift() as string;
      if (seen.has(current)) continue;
      seen.add(current);
      if (leftAncestors.has(current)) return current;
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) rightQueue.push(parent);
    }
    return null;
  }

  /** The paths whose content differs between two trees (plus added/removed). */
  diffTrees(repo: Repo, fromTreeOid: string | null, toTreeOid: string | null): Map<string, string | null> {
    const from = fromTreeOid ? this.flattenTree(repo, fromTreeOid) : new Map<string, string>();
    const to = toTreeOid ? this.flattenTree(repo, toTreeOid) : new Map<string, string>();
    const changes = new Map<string, string | null>();
    for (const [path, oid] of to) if (from.get(path) !== oid) changes.set(path, oid);
    for (const path of from.keys()) if (!to.has(path)) changes.set(path, null);
    return changes;
  }

  /** The base branch's current tip: a merge always runs against the base as it stands now, not as it stood when the pull request was opened. */
  currentBaseSha(repo: Repo, pull: PullRequest): string {
    return repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  }

  /** The head branch's current tip, for the same reason. */
  currentHeadSha(repo: Repo, pull: PullRequest): string {
    return repo.refs.get(`refs/heads/${pull.head}`) ?? pull.headSha;
  }

  /**
   * Whether a squash merge of `pull` would conflict: a path changed on both
   * sides of the merge-base with different results. Pure: creates nothing.
   */
  mergeConflicts(repo: Repo, pull: PullRequest): boolean {
    const headCommit = peelToCommit(this.currentHeadSha(repo, pull), (oid) => repo.objects.get(oid));
    const baseCommit = peelToCommit(this.currentBaseSha(repo, pull), (oid) => repo.objects.get(oid));
    if (headCommit === null || baseCommit === null) return true;
    const baseObject = repo.objects.get(baseCommit);
    const headObject = repo.objects.get(headCommit);
    if (!baseObject || !headObject) return true;
    const baseTree = parseCommit(baseObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const mergeBase = this.mergeBase(repo, baseCommit, headCommit);
    const baseOfMerge = mergeBase === null ? null : parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree;
    const headChanges = this.diffTrees(repo, baseOfMerge, headTree);
    const baseChanges = this.diffTrees(repo, baseOfMerge, baseTree);
    for (const [path, headOid] of headChanges) {
      if (!baseChanges.has(path)) continue;
      if (baseChanges.get(path) !== headOid) return true;
    }
    return false;
  }

  /**
   * The three-way squash merge of a pull request. Returns the new commit sha,
   * or null when the merge would conflict (a path changed on both sides with
   * different results).
   */
  squashMerge(repo: Repo, pull: PullRequest): string | null {
    if (this.mergeConflicts(repo, pull)) return null;
    const headCommit = peelToCommit(this.currentHeadSha(repo, pull), (oid) => repo.objects.get(oid)) as string;
    const baseCommit = peelToCommit(this.currentBaseSha(repo, pull), (oid) => repo.objects.get(oid)) as string;
    const baseObject = repo.objects.get(baseCommit) as GitObject;
    const headObject = repo.objects.get(headCommit) as GitObject;
    const baseTree = parseCommit(baseObject.data).tree;
    const headTree = parseCommit(headObject.data).tree;
    const mergeBase = this.mergeBase(repo, baseCommit, headCommit);
    const baseOfMerge = mergeBase === null ? null : parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree;
    const headChanges = this.diffTrees(repo, baseOfMerge, headTree);
    const merged = this.flattenTree(repo, baseTree);
    for (const [path, oid] of headChanges) {
      if (oid === null) merged.delete(path);
      else merged.set(path, oid);
    }
    const mergedTree = this.buildTreeFromFlat(repo, merged);
    const title = pull.title.trim().length > 0 ? pull.title.trim() : `Merge pull request #${pull.number}`;
    const message = `${title} (#${pull.number})`;
    return this.createCommit(repo, mergedTree, [baseCommit], message);
  }

  /** The file changes of a pull request, head vs its merge-base. */
  pullFileList(repo: Repo, pull: PullRequest): PullFileChange[] {
    const headSha = this.currentHeadSha(repo, pull);
    const baseSha = this.currentBaseSha(repo, pull);
    const headObject = headSha ? repo.objects.get(headSha) : undefined;
    const baseObject = baseSha ? repo.objects.get(baseSha) : undefined;
    if (!headObject || headObject.type !== 'commit' || !baseObject || baseObject.type !== 'commit') return [];
    const headTree = parseCommit(headObject.data).tree;
    const mergeBase = this.mergeBase(repo, baseSha, headSha);
    const mergeBaseTree = mergeBase === null ? null : parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree;
    const changes = this.diffTrees(repo, mergeBaseTree, headTree);
    const baseFlat = this.flattenTree(repo, parseCommit(baseObject.data).tree);
    const countLines = (oid: string | null): number => {
      if (oid === null) return 0;
      const object = repo.objects.get(oid);
      if (!object) return 0;
      const text = object.data.toString('utf8');
      if (text.length === 0) return 0;
      const lines = text.split('\n');
      return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
    };
    const out: PullFileChange[] = [];
    for (const [path, newOid] of changes) {
      const oldOid = baseFlat.get(path) ?? null;
      const status = newOid === null ? 'removed' : oldOid === null ? 'added' : 'modified';
      const newLines = countLines(newOid);
      const oldLines = countLines(oldOid);
      const additions = status === 'added' ? newLines : Math.max(0, newLines - oldLines);
      const deletions = status === 'removed' ? oldLines : Math.max(0, oldLines - newLines);
      out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
    }
    out.sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0));
    return out;
  }

  /** Every object reachable from every ref of a repo (for state export). */
  reachableObjects(repo: Repo): Set<string> {
    const roots: string[] = [];
    for (const oid of repo.refs.values()) roots.push(oid);
    try {
      return collectReachable(roots, (oid) => repo.objects.get(oid));
    } catch {
      return new Set<string>();
    }
  }
}
