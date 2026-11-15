// The forge's single in-memory store: the one user the token names, their repositories, and inside each
// repository the git object database (blobs, trees, commits, tags), the refs, and the forge-native
// records (labels, issues, pull requests, comments). REST, GraphQL and MCP all read and write through
// this module, so an object created on one surface is the same object on every other.
//
// Everything here is deterministic: object ids are SHA-1 over content (git's own rule), record ids come
// from counters, and timestamps come from a logical clock that advances one second per event, never
// from the wall clock. The same sequence of operations always produces the same bytes.

import { createHash } from 'node:crypto';

/** The one user every request authenticates as: the login the trial's token names. */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface LabelRecord {
  name: string;
  color: string;
}

export interface CommentRecord {
  id: number;
  body: string;
}

export interface IssueRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRecord[];
  createdAt: string;
}

export interface PullRecord {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  createdAt: string;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  /** The object database: oid -> object. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> commit or tag oid. */
  refs: Map<string, string>;
  labels: Map<string, LabelRecord>;
  issues: Map<number, IssueRecord>;
  pulls: Map<number, PullRecord>;
  /** Issues and pull requests share one number sequence per repository, as on GitHub. */
  nextNumber: number;
}

/** SHA-1 over git's object framing: "<type> <length>\0" followed by the raw bytes. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export class Forge {
  readonly viewer = VIEWER;
  private repos = new Map<string, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 90000;
  private nextCommentId = 7000;
  private clockTicks = 0;

  /** The next logical timestamp: a fixed epoch plus one second per call, as an ISO string. */
  tick(): string {
    this.clockTicks += 1;
    return new Date(Date.UTC(2026, 0, 1) + this.clockTicks * 1000).toISOString().replace('.000Z', 'Z');
  }

  /** Allocate a globally unique issue/pull record id. */
  allocRecordId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  /** Allocate a globally unique comment id. */
  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner: this.viewer.login,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: this.tick(),
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
    };
    this.nextRepoId += 1;
    this.repos.set(`${repo.owner}/${name}`, repo);
    return repo;
  }

  /** A repository by owner and name; null when the owner is not the viewer or the name is unknown. */
  repo(owner: string, name: string): Repo | null {
    if (owner !== this.viewer.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(`${repo.owner}/${repo.name}`);
  }

  /** Every repository the viewer owns, in creation order. */
  allRepos(): Repo[] {
    return [...this.repos.values()];
  }
}

// ---------------------------------------------------------------------------
// Object database helpers
// ---------------------------------------------------------------------------

/** Store an object and return its oid (storing the same bytes twice is a no-op). */
export function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: Repo, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

/** The blob bytes at an oid, or null when the oid is not a blob in this repository. */
export function blobBytes(repo: Repo, oid: string): Buffer | null {
  const obj = repo.objects.get(oid);
  return obj !== undefined && obj.type === 'blob' ? obj.data : null;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents, message };
}

/** The fixed identity every forge-authored commit carries (keeps authored commits deterministic). */
const AUTHOR_LINE = 'Forge <forge@example.invalid> 1700000000 +0000';

/** Serialize and store a commit; returns its oid. */
export function makeCommit(repo: Repo, tree: string, parents: string[], message: string): string {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${AUTHOR_LINE}`, `committer ${AUTHOR_LINE}`, '', message);
  return putObject(repo, 'commit', Buffer.from(lines.join('\n'), 'utf8'));
}

/** The commit a ref names, following annotated tags; null when unresolvable. */
export function peelToCommit(repo: Repo, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const obj = repo.objects.get(current);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) return null;
      current = match[1]!;
      continue;
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse one tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    const nul = data.indexOf(0x00, space);
    const mode = data.toString('utf8', pos, space);
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Git's tree entry order: by name bytes, with directories compared as if the name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialize and store a tree from its entries (sorted by git's rule). */
export function makeTree(repo: Repo, entries: TreeEntry[]): string {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return putObject(repo, 'tree', Buffer.concat(parts));
}

/** The empty tree's oid in this repository (stored on demand). */
export function emptyTree(repo: Repo): string {
  return makeTree(repo, []);
}

/** Flatten a tree into path -> blob entry, walking subtrees. */
export function flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build (and store) a tree from a flattened path -> blob map. */
export function treeFromFlat(repo: Repo, flat: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i]!;
      if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
      node = node.dirs.get(part)!;
    }
    node.files.set(parts[parts.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return makeTree(repo, entries);
  };
  return build(root);
}

/** The tree oid of a commit, or null when the oid is not a commit here. */
export function commitTree(repo: Repo, commitOid: string): string | null {
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

// ---------------------------------------------------------------------------
// Ancestry, merge base, three-way merge, diffs
// ---------------------------------------------------------------------------

/** Every commit reachable from `tip` through parent edges, tip included. */
export function ancestorsOf(repo: Repo, tip: string): Set<string> {
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return seen;
}

/** Whether `ancestor` is reachable from `descendant` (equality counts). */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  return ancestorsOf(repo, descendant).has(ancestor);
}

/** Commits reachable from `tip`, newest first (a child always precedes its parents). */
export function listCommits(repo: Repo, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(obj.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
  }
  return order;
}

/** The best common ancestor of two commits: a common ancestor that is not an ancestor of another one. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  const fromA = ancestorsOf(repo, a);
  const seen = new Set<string>();
  const queue = [b];
  const common: string[] = [];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    if (fromA.has(oid)) common.push(oid);
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  for (const candidate of common) {
    const shadowed = common.some((other) => other !== candidate && isAncestor(repo, candidate, other));
    if (!shadowed) return candidate;
  }
  return common[0] ?? null;
}

export interface MergeOutcome {
  /** The merged tree oid, or null when the merge conflicts. */
  tree: string | null;
  /** The paths that conflict, when tree is null. */
  conflicts: string[];
}

/**
 * A three-way tree merge against a merge base, per path: a path changed on only one side takes that
 * side's version; changed identically on both takes it; changed differently on both (or deleted on
 * one side and changed on the other) conflicts.
 */
export function mergeTrees(repo: Repo, baseTree: string, ourTree: string, theirTree: string): MergeOutcome {
  const base = flattenTree(repo, baseTree);
  const ours = flattenTree(repo, ourTree);
  const theirs = flattenTree(repo, theirTree);
  const paths = new Set<string>([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  const merged = new Map<string, { oid: string; mode: string }>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const b = base.get(path)?.oid;
    const o = ours.get(path)?.oid;
    const t = theirs.get(path)?.oid;
    if (o === t) {
      if (o !== undefined) merged.set(path, ours.get(path) ?? theirs.get(path)!);
    } else if (b === o) {
      if (t !== undefined) merged.set(path, theirs.get(path)!);
    } else if (b === t) {
      if (o !== undefined) merged.set(path, ours.get(path)!);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { tree: null, conflicts };
  return { tree: treeFromFlat(repo, merged), conflicts: [] };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** The lines of a text blob: a trailing newline terminates the last line rather than starting one. */
function linesOf(data: Buffer): string[] {
  const text = data.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line counts between two blob versions: multiset difference of their lines. */
function lineDelta(repo: Repo, fromOid: string | undefined, toOid: string | undefined): { additions: number; deletions: number } {
  const fromLines = fromOid === undefined ? [] : linesOf(blobBytes(repo, fromOid) ?? Buffer.alloc(0));
  const toLines = toOid === undefined ? [] : linesOf(blobBytes(repo, toOid) ?? Buffer.alloc(0));
  const counts = new Map<string, number>();
  for (const line of fromLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of toLines) {
    const held = counts.get(line) ?? 0;
    if (held > 0) counts.set(line, held - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const count of counts.values()) deletions += count;
  return { additions, deletions };
}

/** The file-level diff between two trees, paths in sorted order. */
export function diffTrees(repo: Repo, fromTree: string, toTree: string): FileDiff[] {
  const from = flattenTree(repo, fromTree);
  const to = flattenTree(repo, toTree);
  const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
  const diffs: FileDiff[] = [];
  for (const path of paths) {
    const f = from.get(path)?.oid;
    const t = to.get(path)?.oid;
    if (f === t) continue;
    const { additions, deletions } = lineDelta(repo, f, t);
    diffs.push({
      filename: path,
      status: f === undefined ? 'added' : t === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return diffs;
}
