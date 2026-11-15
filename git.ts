// Git object model, packfile codec, pkt-line framing and the smart-HTTP
// protocol (upload-pack v2 / v0, receive-pack v0), all from the standard
// library (node:crypto, node:zlib). No git binary, no dependency.
//
// The wire shapes follow git's protocol documentation as the suite's own
// client (kit program/env/src/git-client.ts) speaks it:
//   - info/refs: v0 opens with "# service=git-<service>" then ref lines
//     "<oid> <ref>\0<caps>" (first line carries the capabilities); v2 opens
//     with "version 2" then one capability line each.
//   - upload-pack v2: command=ls-refs / command=fetch, sections
//     acknowledgments / shallow-info / packfile (sideband band 1 = pack).
//   - receive-pack v0: "<old> <new> <ref>" command lines, a packfile, and a
//     report-status answer framed in sideband band 1.
// Packs this server writes carry plain objects only (no deltas): a valid
// packfile, and the suite resolves it without a delta step. Packs it reads
// are the client's plain-object packs; a delta entry is an unpack failure.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}
export type ObjectLookup = (oid: string) => GitObject | undefined;

export const ZERO_OID = '0'.repeat(40);
const HEX40 = /^[0-9a-f]{40}$/;
export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(Buffer.from(`${type} ${data.length}\u0000`, 'utf8'));
  hash.update(data);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// object parsing / building
// ---------------------------------------------------------------------------------------------

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function compareTreeNames(a: { name: string; mode: string }, b: { name: string; mode: string }): number {
  const left = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const right = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(left, right);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\u0000`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  if (!isObjectId(tree)) throw new Error('commit has no valid tree header');
  return { tree, parents, author, committer, message };
}

export interface TagView {
  readonly object: string;
  readonly type: GitObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const headerEnd = blank < 0 ? data.length : blank;
  const headers = new Map<string, string>();
  for (const line of data.subarray(0, headerEnd).toString('utf8').split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    if (space < 0) throw new Error('malformed tag header');
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  const object = headers.get('object') ?? '';
  const type = headers.get('type') ?? '';
  if (!isObjectId(object)) throw new Error('tag has no valid object header');
  if (type !== 'commit' && type !== 'tree' && type !== 'blob' && type !== 'tag') throw new Error('tag has bad type');
  return { object, type: type as GitObjectType, tag: headers.get('tag') ?? '', tagger: headers.get('tagger') ?? '', message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8') };
}

/** Every object reachable from `roots` (gitlinks skipped). Throws on a missing object. */
export function collectReachable(roots: Iterable<string>, lookup: ObjectLookup): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const root of roots) if (isObjectId(root)) queue.push(root);
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = lookup(oid);
    if (!object) throw new Error(`object ${oid} is missing from the store`);
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      queue.push(commit.tree);
      for (const parent of commit.parents) queue.push(parent);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') queue.push(entry.oid);
      }
    }
  }
  return seen;
}

/** Peel a tag (repeatedly) to the commit it names, or the oid itself when it is one. */
export function peelToCommit(oid: string, lookup: ObjectLookup): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = lookup(current);
    if (!object) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// packfile read / write (plain objects only)
// ---------------------------------------------------------------------------------------------

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Read a packfile (version 2/3, plain objects only) into a map of oid -> object. */
export function readPack(pack: Buffer): Map<string, GitObject> {
  if (pack.length < 32) throw new Error(`pack is ${pack.length} bytes, too short`);
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    if (offset >= trailerStart) throw new Error('pack entry header is truncated');
    let byte = pack[offset];
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      if (offset >= trailerStart) throw new Error('pack entry size varint is truncated');
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6 || typeCode === 7) throw new Error('delta pack entries are not accepted');
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`pack entry ${index} has unknown type code ${typeCode}`);
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error(`pack entry at ${offset} declares ${size} bytes but inflated to ${inflated.data.length}`);
    offset = inflated.next;
    const oid = hashObject(type, inflated.data);
    objects.set(oid, { type, data: inflated.data });
  }
  if (offset !== trailerStart) throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  return objects;
}

function encodePackEntryHeader(typeCode: number, size: number): Buffer {
  const out: number[] = [];
  const first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size === 0) {
    out.push(first);
  } else {
    out.push(first | 0x80);
    for (;;) {
      const byte = size & 0x7f;
      size >>>= 7;
      if (size !== 0) out.push(byte | 0x80);
      else {
        out.push(byte);
        break;
      }
    }
  }
  return Buffer.from(out);
}

/** Write a packfile (version 2, plain objects) for `objects`. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(encodePackEntryHeader(TYPE_CODE[object.type], object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------------------------

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > 65520) throw new Error('pkt-line payload over 65516 bytes');
  const header = Buffer.alloc(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

const HEX4 = /^[0-9a-fA-F]{4}$/;

/** Decode a complete buffer of pkt-lines; throws on malformed framing. */
export function decodePktLines(bytes: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Decode pkt-lines from the start of `bytes` until the first flush; returns the packets and the offset just past that flush. */
export function decodePktLinesUntilFlush(bytes: Buffer): { packets: PktPacket[]; restOffset: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  for (;;) {
    if (offset + 4 > bytes.length) throw new Error('truncated pkt-line header');
    const head = bytes.subarray(offset, offset + 4).toString('ascii');
    if (!HEX4.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, restOffset: offset + 4 };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3 || length > 65520) {
      throw new Error(`invalid pkt-line length ${length}`);
    } else {
      if (offset + length > bytes.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
}

function pktLinesText(packets: readonly PktPacket[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// the repository view the protocol needs
// ---------------------------------------------------------------------------------------------

export interface GitRepoView {
  readonly defaultBranch: string;
  getObject(oid: string): GitObject | undefined;
  putObject(type: GitObjectType, data: Buffer): string;
  getRef(name: string): string | undefined;
  setRef(name: string, oid: string): void;
  deleteRef(name: string): void;
  /** Every ref, sorted by name. */
  listRefs(): Array<{ name: string; oid: string }>;
}

// ---------------------------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------------------------

const AGENT = 'forge/1.0';

function v0Capabilities(service: 'git-upload-pack' | 'git-receive-pack'): string {
  const common = `symref=HEAD:refs/heads/main object-format=sha1 agent=${AGENT}`;
  if (service === 'git-upload-pack') return `side-band-64k ofs-delta ${common}`;
  return `report-status side-band-64k delete-refs ofs-delta ${common}`;
}

/** The v0 ref advertisement, with the "# service=..." preamble. */
export function advertisementV0(repo: GitRepoView, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = v0Capabilities(service);
  const refs = repo.listRefs();
  const headTip = repo.getRef(`refs/heads/${repo.defaultBranch}`);
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\u0000${caps}\n`);
  } else {
    const headLine = headTip !== undefined ? `${headTip} HEAD\u0000${caps}\n` : null;
    if (headLine !== null) lines.push(headLine);
    let first = headLine === null;
    for (const ref of refs) {
      const suffix = first ? `\u0000${caps}` : '';
      first = false;
      lines.push(`${ref.oid} ${ref.name}${suffix}\n`);
      const object = repo.getObject(ref.oid);
      if (object && object.type === 'tag') {
        const peeled = peelToCommit(ref.oid, (oid) => repo.getObject(oid));
        if (peeled !== null) lines.push(`${peeled} ${ref.name}^{}\n`);
      }
    }
  }
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement, with the "# service=..." preamble. */
export function advertisementV2(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), PKT_FLUSH];
  const lines = [
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  for (const line of lines) parts.push(pktLine(line));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------------------------

export interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function peelTarget(oid: string, repo: GitRepoView): string | null {
  const object = repo.getObject(oid);
  if (!object) return null;
  if (object.type === 'commit') return oid;
  if (object.type === 'tag') return peelToCommit(oid, (id) => repo.getObject(id));
  return null;
}

export function handleLsRefs(repo: GitRepoView, args: LsRefsArgs): Buffer {
  const parts: Buffer[] = [];
  const refs = repo.listRefs();
  const keep = (name: string): boolean => args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const headTip = repo.getRef(`refs/heads/${repo.defaultBranch}`);
  // HEAD is a symref, not a ref under any prefix: it answers only when no
  // prefix filter is in force, or a prefix filter would otherwise return
  // nothing but the symref itself.
  if (args.symrefs && args.prefixes.length === 0) {
    if (headTip !== undefined) {
      parts.push(pktLine(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    } else if (args.unborn) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelTarget(ref.oid, repo);
      if (peeled !== null && ref.name.startsWith('refs/tags/')) line += ` peeled:${peeled}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// fetch (v2 and v0 share the object selection)
// ---------------------------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallowIn: string[];
  depth: number | null;
}

export interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

export function selectFetch(repo: GitRepoView, args: FetchArgs): FetchSelection {
  const lookup = (oid: string): GitObject | undefined => repo.getObject(oid);
  // The objects the client already holds: the closure of its haves, stopping
  // at its shallow boundaries — a shallow commit's tree is held, its parents
  // are not. A plain closure would claim the client holds the very history a
  // deepen fetch is asking for, and the parent would never be delivered.
  const shallowHeld = new Set(args.shallowIn);
  const haveClosure = new Set<string>();
  {
    const queue: string[] = [...args.haves];
    while (queue.length) {
      const oid = queue.pop() as string;
      if (haveClosure.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      haveClosure.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        queue.push(commit.tree);
        if (!shallowHeld.has(oid)) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        queue.push(parseTag(object.data).object);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') queue.push(entry.oid);
        }
      }
    }
  }
  // BFS over commits from the wants, tracking the shortest distance from any want.
  const commitDepth = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const extraObjects = new Map<string, GitObject>();
  for (const want of args.wants) {
    const object = lookup(want);
    if (!object) continue;
    if (object.type === 'tag') {
      extraObjects.set(want, object);
      const target = peelToCommit(want, lookup);
      if (target !== null && !commitDepth.has(target)) {
        commitDepth.set(target, 0);
        queue.push({ oid: target, depth: 0 });
      }
    } else if (object.type === 'commit') {
      if (!commitDepth.has(want)) {
        commitDepth.set(want, 0);
        queue.push({ oid: want, depth: 0 });
      }
    } else {
      extraObjects.set(want, object);
    }
  }
  const boundary = new Set<string>();
  let head = 0;
  while (head < queue.length) {
    const current = queue[head++] as { oid: string; depth: number };
    if (args.depth !== null && current.depth >= args.depth) {
      boundary.add(current.oid);
      continue;
    }
    const object = lookup(current.oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      const nextDepth = current.depth + 1;
      const known = commitDepth.get(parent);
      if (known === undefined || nextDepth < known) {
        commitDepth.set(parent, nextDepth);
        queue.push({ oid: parent, depth: nextDepth });
      }
    }
  }
  // Included commits: visited, within depth, and not already held.
  const included = new Set<string>();
  for (const [oid, depth] of commitDepth) {
    if (args.depth !== null && depth >= args.depth) continue;
    if (haveClosure.has(oid)) continue;
    included.add(oid);
  }
  // Shallow: an included commit with a parent neither included nor held.
  const shallow: string[] = [];
  for (const oid of included) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent) && !haveClosure.has(parent)) {
        shallow.push(oid);
        break;
      }
    }
  }
  // Unshallow: a previous boundary whose every parent is now included or
  // held. The boundary commit itself need not be in the pack — in a deepen
  // it is already held, and it is the delivery of its parent that unshallows
  // it — but it must be held or included for the claim to mean anything.
  const unshallow: string[] = [];
  for (const oid of args.shallowIn) {
    if (!included.has(oid) && !haveClosure.has(oid)) continue;
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    let allHeld = true;
    for (const parent of parseCommit(object.data).parents) {
      if (!included.has(parent) && !haveClosure.has(parent)) {
        allHeld = false;
        break;
      }
    }
    if (allHeld) unshallow.push(oid);
  }
  // The object set: the tree closures of the included commits, plus the
  // wanted tags/objects — never the parents of an included commit. A parent
  // is only an object here when it is itself included (or held, and then it
  // is excluded below); following parents would hand a shallow fetch the
  // history it asked not to receive.
  const objectIds = new Set<string>();
  const addTreeClosure = (treeOid: string): void => {
    const stack: string[] = [treeOid];
    while (stack.length) {
      const oid = stack.pop() as string;
      if (objectIds.has(oid)) continue;
      const object = lookup(oid);
      if (!object) continue;
      objectIds.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      }
    }
  };
  for (const oid of included) {
    const object = lookup(oid);
    if (!object || object.type !== 'commit') continue;
    objectIds.add(oid);
    addTreeClosure(parseCommit(object.data).tree);
  }
  for (const [oid, object] of extraObjects) {
    objectIds.add(oid);
    if (object.type === 'tag') {
      const target = parseTag(object.data).object;
      const targetObject = lookup(target);
      if (!targetObject) continue;
      if (targetObject.type === 'commit') {
        if (!objectIds.has(target)) {
          objectIds.add(target);
          addTreeClosure(parseCommit(targetObject.data).tree);
        }
      } else if (targetObject.type === 'tree') {
        addTreeClosure(target);
      } else {
        objectIds.add(target);
      }
    }
  }
  const objects: GitObject[] = [];
  for (const oid of objectIds) {
    if (haveClosure.has(oid)) continue;
    const object = lookup(oid);
    if (object) objects.push(object);
  }
  // Deterministic order: sort by oid, with each oid computed once (the
  // comparator used to re-hash every object on every comparison).
  const withOid = objects.map((object) => ({ oid: hashObject(object.type, object.data), object }));
  withOid.sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  return { objects: withOid.map((entry) => entry.object), shallow: shallow.sort(), unshallow: unshallow.sort() };
}

/** Split pack bytes into sideband band-1 pkt-lines (<= 65516 payload bytes each). */
function sidebandPack(pack: Buffer): Buffer[] {
  const parts: Buffer[] = [];
  const max = 65516 - 1;
  for (let offset = 0; offset < pack.length; offset += max) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + max));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    // An empty pack still needs one band-1 packet for the section to exist.
    parts.push(pktLine(Buffer.from([1])));
  }
  return parts;
}

export function handleFetchV2(repo: GitRepoView, args: FetchArgs): Buffer {
  const selection = selectFetch(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  parts.push(pktLine('NAK\n'));
  parts.push(PKT_FLUSH);
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  for (const part of sidebandPack(pack)) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

export function handleFetchV0(repo: GitRepoView, args: FetchArgs): Buffer {
  const selection = selectFetch(repo, args);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const part of sidebandPack(pack)) parts.push(part);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack POST: dispatch v2 commands or the v0 want/have exchange
// ---------------------------------------------------------------------------------------------

export function parseV2Command(body: Buffer): { command: string; args: FetchArgs | LsRefsArgs } {
  const packets = decodePktLines(body);
  const lines = pktLinesText(packets);
  const delimAt = packets.findIndex((packet) => packet.kind === 'delim');
  const argLines = delimAt < 0 ? lines.slice(1) : pktLinesText(packets.slice(delimAt + 1));
  const commandLine = lines[0] ?? '';
  const command = commandLine.startsWith('command=') ? commandLine.slice('command='.length).trim() : '';
  if (command === 'ls-refs') {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const line of argLines) {
      const text = line.trim();
      if (text === 'peel') args.peel = true;
      else if (text === 'symrefs') args.symrefs = true;
      else if (text === 'unborn') args.unborn = true;
      else if (text.startsWith('ref-prefix ')) args.prefixes.push(text.slice('ref-prefix '.length));
    }
    return { command, args };
  }
  if (command === 'fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallowIn: [], depth: null };
    for (const line of argLines) {
      const text = line.trim();
      if (text.startsWith('want ')) args.wants.push(text.slice(5).trim());
      else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
      else if (text.startsWith('shallow ')) args.shallowIn.push(text.slice(8).trim());
      else if (text.startsWith('deepen ')) {
        const depth = Number.parseInt(text.slice(7).trim(), 10);
        if (Number.isFinite(depth)) args.depth = depth;
      }
    }
    return { command, args };
  }
  throw new Error(`unknown v2 command ${JSON.stringify(command)}`);
}

export function parseV0Fetch(body: Buffer): FetchArgs {
  const packets = decodePktLines(body);
  const args: FetchArgs = { wants: [], haves: [], shallowIn: [], depth: null };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) args.wants.push(text.slice(5).split(' ')[0] as string);
    else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallowIn.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) {
      const depth = Number.parseInt(text.slice(7).trim(), 10);
      if (Number.isFinite(depth)) args.depth = depth;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------------------------
// receive-pack (v0)
// ---------------------------------------------------------------------------------------------

export interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export interface PushReportLine {
  readonly ref: string;
  readonly ok: boolean;
  readonly reason: string;
}

function isAncestor(maybeAncestor: string, oid: string, lookup: ObjectLookup): boolean {
  if (maybeAncestor === oid) return true;
  const seen = new Set<string>();
  const queue: string[] = [oid];
  while (queue.length) {
    const current = queue.pop() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    const object = lookup(current);
    if (!object) continue;
    if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
      continue;
    }
    if (object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === maybeAncestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/**
 * Handle a receive-pack POST body. Parses the command list and pack, stores the
 * pack's objects, then applies each command: a fast-forward update (or a
 * create/delete whose old value matches) is ok; anything else is refused per
 * ref with "non-fast-forward" and leaves that ref alone.
 */
export function handleReceivePack(repo: GitRepoView, body: Buffer): Buffer {
  const lines: PushReportLine[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  try {
    // The command list ends at the first flush; everything after it is the pack.
    const { packets, restOffset } = decodePktLinesUntilFlush(body);
    const commandLines = pktLinesText(packets.filter((packet) => packet.kind === 'data'));
    const commands: PushCommand[] = [];
    for (const line of commandLines) {
      const nul = line.indexOf('\u0000');
      const text = (nul < 0 ? line : line.slice(0, nul)).trim();
      const parts = text.split(' ');
      if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(text)}`);
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
    }
    const packBytes = body.subarray(restOffset);
    if (packBytes.length > 0) {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        const existing = repo.getObject(oid);
        if (!existing) repo.putObject(object.type, object.data);
      }
    }
    const lookup = (oid: string): GitObject | undefined => repo.getObject(oid);
    for (const command of commands) {
      const current = repo.getRef(command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          lines.push({ ref: command.ref, ok: false, reason: 'failed to update ref' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          lines.push({ ref: command.ref, ok: false, reason: 'failed to update ref' });
        } else {
          repo.deleteRef(command.ref);
          lines.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      const target = lookup(command.newOid);
      if (!target) {
        lines.push({ ref: command.ref, ok: false, reason: 'object not found' });
        continue;
      }
      if (current === undefined) {
        if (command.oldOid !== ZERO_OID) {
          lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          repo.setRef(command.ref, command.newOid);
          lines.push({ ref: command.ref, ok: true, reason: '' });
        }
        continue;
      }
      if (command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      const newCommit = peelToCommit(command.newOid, lookup);
      if (newCommit === null || !isAncestor(current, newCommit, lookup)) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.setRef(command.ref, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
    }
  } catch (err) {
    unpackOk = false;
    unpackDetail = err instanceof Error ? err.message : String(err);
  }
  const report = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const line of lines) {
    report.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  const reportBytes = Buffer.concat(report.map((text) => pktLine(text)));
  const parts: Buffer[] = [pktLine(Buffer.concat([Buffer.from([1]), reportBytes])), PKT_FLUSH];
  return Buffer.concat(parts);
}
