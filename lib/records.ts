// Record shaping and the shared write operations. REST, GraphQL and MCP must present the same
// objects (the suite reads an MCP-created issue back over REST and compares ids), so every serializer
// and every mutation lives here exactly once and the three surfaces are thin adapters over it.

import {
  commitTree,
  diffTrees,
  emptyTree,
  isAncestor,
  makeCommit,
  mergeBase,
  mergeTrees,
  type CommentRecord,
  type Forge,
  type IssueRecord,
  type PullRecord,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------
// Serializers (the REST shapes; GraphQL and MCP project from the same records)
// ---------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login: repo.owner, id: forge.viewer.id, type: 'User' },
    created_at: repo.createdAt,
    updated_at: repo.createdAt,
    html_url: `http://forge.invalid/${repo.owner}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, repo: Repo, issue: IssueRecord): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    comments: issue.comments.length,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.createdAt,
  };
}

export function commentJson(forge: Forge, comment: CommentRecord): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
  };
}

/** The live tip of a branch, or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRecord): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.headRef,
      sha: branchTip(repo, pull.headRef),
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: branchTip(repo, pull.baseRef),
      label: `${repo.owner}:${pull.baseRef}`,
    },
    user: { login: forge.viewer.login, id: forge.viewer.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Global ids (GraphQL node ids): opaque, stable, and never the bare database id
// ---------------------------------------------------------------------------

export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function repoGlobalId(repo: Repo): string {
  return globalId('Repository', repo.id);
}

export function issueGlobalId(repo: Repo, issue: IssueRecord): string {
  return globalId('Issue', repo.id, issue.number);
}

export function pullGlobalId(repo: Repo, pull: PullRecord): string {
  return globalId('PullRequest', repo.id, pull.number);
}

export function commentGlobalId(repo: Repo, issue: IssueRecord, comment: CommentRecord): string {
  return globalId('IssueComment', repo.id, issue.number, comment.id);
}

/** Decode a global id into its kind and parts; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2 || parts[0] === '') return null;
    return { kind: parts[0]!, parts: parts.slice(1) };
  } catch {
    return null;
  }
}

/** Find a repository by its database id (GraphQL repositoryId inputs carry the global form). */
export function repoByGlobalId(forge: Forge, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const dbId = Number.parseInt(parsed.parts[0]!, 10);
  return forge.allRepos().find((repo) => repo.id === dbId) ?? null;
}

// ---------------------------------------------------------------------------
// Shared operations
// ---------------------------------------------------------------------------

/** Create an issue record. Labels must already exist (callers validate, or pass only known names). */
export function createIssue(forge: Forge, repo: Repo, input: { title: string; body: string; labels?: string[] }): IssueRecord {
  const issue: IssueRecord = {
    id: forge.allocRecordId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    labels: input.labels ?? [],
    comments: [],
    createdAt: forge.tick(),
  };
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(forge: Forge, issue: IssueRecord, body: string): CommentRecord {
  const comment: CommentRecord = { id: forge.allocCommentId(), body };
  issue.comments.push(comment);
  return comment;
}

/** The open pull request for a head/base pair, if one exists. */
export function openPullFor(repo: Repo, headRef: string, baseRef: string): PullRecord | null {
  for (const pull of repo.pulls.values()) {
    if (pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef) return pull;
  }
  return null;
}

export function createPull(forge: Forge, repo: Repo, input: { title: string; body: string; headRef: string; baseRef: string }): PullRecord {
  const pull: PullRecord = {
    id: forge.allocRecordId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body,
    state: 'open',
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    headRef: input.headRef,
    baseRef: input.baseRef,
    createdAt: forge.tick(),
  };
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

/** The merge base commit of a pull request's two branch tips, or null. */
export function pullMergeBase(repo: Repo, pull: PullRecord): string | null {
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return null;
  return mergeBase(repo, head, base);
}

/** Whether a pull request's head still merges cleanly into its base (three-way test). */
export function pullMergeable(repo: Repo, pull: PullRecord): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return 'UNKNOWN';
  const baseCommit = mergeBase(repo, head, base);
  if (baseCommit === null) return 'CONFLICTING';
  const outcome = mergeTrees(repo, commitTree(repo, baseCommit) ?? emptyTree(repo), commitTree(repo, base)!, commitTree(repo, head)!);
  return outcome.tree === null ? 'CONFLICTING' : 'MERGEABLE';
}

/** The files a pull request changes: merge-base tree against head tree. */
export function pullFiles(repo: Repo, pull: PullRecord) {
  const head = branchTip(repo, pull.headRef);
  if (head === null) return [];
  const baseCommit = pullMergeBase(repo, pull);
  const fromTree = baseCommit === null ? emptyTree(repo) : (commitTree(repo, baseCommit) ?? emptyTree(repo));
  const toTree = commitTree(repo, head) ?? emptyTree(repo);
  return diffTrees(repo, fromTree, toTree);
}

export type MergeResult = { ok: true; sha: string } | { ok: false; reason: 'conflict' | 'not-open' | 'missing-ref' };

/**
 * Squash-merge a pull request: one new commit on the base branch whose tree is the three-way merge
 * of the merge base, the base tip and the head tip, with the old base tip as its only parent.
 */
export function mergePull(forge: Forge, repo: Repo, pull: PullRecord): MergeResult {
  if (pull.merged) return { ok: true, sha: pull.mergeCommitSha ?? '' };
  if (pull.state !== 'open') return { ok: false, reason: 'not-open' };
  const head = branchTip(repo, pull.headRef);
  const base = branchTip(repo, pull.baseRef);
  if (head === null || base === null) return { ok: false, reason: 'missing-ref' };
  let sha: string;
  if (isAncestor(repo, head, base)) {
    // The head is already contained in the base: nothing to commit, the base tip is the result.
    sha = base;
  } else {
    const baseCommit = mergeBase(repo, head, base);
    const baseTree = baseCommit === null ? emptyTree(repo) : (commitTree(repo, baseCommit) ?? emptyTree(repo));
    const outcome = mergeTrees(repo, baseTree, commitTree(repo, base)!, commitTree(repo, head)!);
    if (outcome.tree === null) return { ok: false, reason: 'conflict' };
    sha = makeCommit(repo, outcome.tree, [base], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  }
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = forge.tick();
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}
