// The REST v3 surface under /api/v3. Every reply is JSON with a string `message` on errors; app.ts
// adds the X-GitHub-Request-Id header and the transport framing. Status codes follow the wire
// contract: 201 creates, 200 updates and reads, 204 delete, 404 unknown repo/route, 409 a stale
// contents sha, 422 validation failures (a duplicate repository name — whose body must say "already
// exists" — an unknown issue label, a duplicate open pull request).

import {
  branchTip,
  commentJson,
  createIssue,
  createPull,
  issueJson,
  mergePull,
  openPullFor,
  pullFiles,
  pullJson,
  repoJson,
  addComment,
} from './records.ts';
import {
  flattenTree,
  listCommits,
  makeCommit,
  parseCommit,
  putObject,
  treeFromFlat,
  commitTree,
  emptyTree,
  type Forge,
  type Repo,
} from './store.ts';

export interface RestReply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

function err(status: number, message: string): RestReply {
  return { status, body: { message } };
}

function ok(status: number, body: unknown, headers?: Record<string, string>): RestReply {
  return { status, body, headers };
}

/** A JSON body field read as a string, or null when absent or not a string. */
function str(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' ? value : null;
}

/** A JSON body field read as a boolean, with a default. */
function bool(body: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = body[key];
  return typeof value === 'boolean' ? value : fallback;
}

/** The label names an issue payload names (strings, or {name} objects), or null when malformed. */
function labelNames(body: Record<string, unknown>): string[] | null {
  const raw = body.labels;
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') names.push(item);
    else if (item !== null && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string') names.push((item as Record<string, unknown>).name as string);
    else return null;
  }
  return names;
}

/** Page through a list with per_page/page, adding a Link header when a next page exists. */
function paginate<T>(items: T[], query: URLSearchParams, url: string): { page: T[]; headers?: Record<string, string> } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 1000) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  if (start + perPage < items.length && url !== '') {
    const next = new URL(url);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    const lastPage = Math.ceil(items.length / perPage);
    const last = new URL(url);
    last.searchParams.set('per_page', String(perPage));
    last.searchParams.set('page', String(lastPage));
    return { page: slice, headers: { link: `<${next.toString()}>; rel="next", <${last.toString()}>; rel="last"` } };
  }
  return { page: slice };
}

export function handleRest(forge: Forge, method: string, segments: string[], query: URLSearchParams, rawBody: unknown, baseUrl: string): RestReply {
  const body: Record<string, unknown> = rawBody !== null && typeof rawBody === 'object' && !Array.isArray(rawBody) ? (rawBody as Record<string, unknown>) : {};
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(
      200,
      {
        current_user_url: `${baseUrl}/api/v3/user`,
        repository_url: `${baseUrl}/api/v3/repos/{owner}/{repo}`,
        issue_url: `${baseUrl}/api/v3/repos/{owner}/{repo}/issues`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { installed_version: '1.0.0', verifiable_password_authentication: false });
  }

  if (head === 'user') return userRoutes(forge, method, rest, query, body, baseUrl);
  if (head === 'repos') return repoRoutes(forge, method, rest, query, body, baseUrl);
  return err(404, 'Not Found');
}

function userRoutes(forge: Forge, method: string, segments: string[], query: URLSearchParams, body: Record<string, unknown>, baseUrl: string): RestReply {
  if (segments.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return ok(200, { login: forge.viewer.login, id: forge.viewer.id, name: forge.viewer.name, email: forge.viewer.email, type: 'User' });
  }
  if (segments[0] === 'repos' && segments.length === 1) {
    if (method === 'GET') {
      const all = forge.allRepos().map((repo) => repoJson(forge, repo));
      const { page, headers } = paginate(all, query, `${baseUrl}/api/v3/user/repos`);
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const name = str(body, 'name');
      if (name === null || name === '') return err(422, 'Repository creation failed: name is required');
      if (forge.repo(forge.viewer.login, name) !== null) {
        return err(422, `Repository creation failed: a repository named '${name}' already exists on this account`);
      }
      const repo = forge.createRepo(name, str(body, 'description') ?? '', bool(body, 'private', false));
      const defaultBranch = str(body, 'default_branch');
      if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return ok(201, repoJson(forge, repo));
    }
  }
  return err(404, 'Not Found');
}

function repoRoutes(forge: Forge, method: string, segments: string[], query: URLSearchParams, body: Record<string, unknown>, baseUrl: string): RestReply {
  const [owner, name, ...tail] = segments;
  if (owner === undefined || name === undefined) return err(404, 'Not Found');
  const repo = forge.repo(owner, name);
  if (repo === null) return err(404, 'Not Found');

  if (tail.length === 0) {
    if (method === 'GET') return ok(200, repoJson(forge, repo));
    if (method === 'PATCH') {
      const description = str(body, 'description');
      if (description !== null) repo.description = description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      const defaultBranch = str(body, 'default_branch');
      if (defaultBranch !== null && defaultBranch !== '') repo.defaultBranch = defaultBranch;
      return ok(200, repoJson(forge, repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(repo);
      return { status: 204 };
    }
    return err(404, 'Not Found');
  }

  const [area, ...sub] = tail;
  switch (area) {
    case 'contents':
      return contentsRoutes(forge, repo, method, sub.join('/'), query, body);
    case 'labels':
      return labelRoutes(repo, method, sub, body);
    case 'issues':
      return issueRoutes(forge, repo, method, sub, query, body);
    case 'pulls':
      return pullRoutes(forge, repo, method, sub, query, body);
    case 'git':
      return gitRoutes(repo, method, sub, body);
    case 'branches':
      return branchRoutes(repo, method, sub);
    case 'commits':
      if (method === 'GET') return commitList(repo, query);
      return err(404, 'Not Found');
    default:
      return err(404, 'Not Found');
  }
}

// ---------------------------------------------------------------------------
// Contents
// ---------------------------------------------------------------------------

/** Resolve a ?ref= value (branch name or commit sha) to a commit; default is the default branch tip. */
function resolveRef(repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return branchTip(repo, repo.defaultBranch);
  const byBranch = branchTip(repo, ref);
  if (byBranch !== null) return byBranch;
  if (/^[0-9a-f]{40}$/.test(ref) && repo.objects.has(ref)) return ref;
  return null;
}

function contentsRoutes(forge: Forge, repo: Repo, method: string, path: string, query: URLSearchParams, body: Record<string, unknown>): RestReply {
  if (method === 'GET') {
    const commit = resolveRef(repo, query.get('ref'));
    if (commit === null) return err(404, 'Not Found');
    const tree = commitTree(repo, commit);
    if (tree === null) return err(404, 'Not Found');
    const flat = flattenTree(repo, tree);
    if (path === '') {
      return ok(200, dirListing(repo, tree, ''));
    }
    const file = flat.get(path);
    if (file !== undefined) {
      const data = repo.objects.get(file.oid)?.data ?? Buffer.alloc(0);
      return ok(200, {
        type: 'file',
        name: path.split('/').pop(),
        path,
        sha: file.oid,
        size: data.length,
        encoding: 'base64',
        content: data.toString('base64'),
      });
    }
    // A directory when any file lives under it.
    const prefix = `${path}/`;
    if ([...flat.keys()].some((key) => key.startsWith(prefix))) return ok(200, dirListing(repo, tree, path));
    return err(404, 'Not Found');
  }

  if (method === 'PUT') {
    const contentB64 = str(body, 'content');
    if (contentB64 === null) return err(422, 'content is required');
    const data = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    let tip = branchTip(repo, branch);
    if (tip === null) {
      // A contents write to a branch that does not exist yet starts it from the default branch tip
      // (or from nothing, on an unborn repository).
      tip = branchTip(repo, repo.defaultBranch);
    }
    const baseTree = tip === null ? emptyTree(repo) : (commitTree(repo, tip) ?? emptyTree(repo));
    const flat = flattenTree(repo, baseTree);
    const existing = flat.get(path);
    const givenSha = str(body, 'sha');
    if (existing !== undefined && givenSha !== null && givenSha !== existing.oid) {
      return err(409, 'Conflict: the sha does not match the current file');
    }
    const blobOid = putObject(repo, 'blob', data);
    flat.set(path, { oid: blobOid, mode: '100644' });
    const newTree = treeFromFlat(repo, flat);
    const message = str(body, 'message') ?? (existing !== undefined ? `Update ${path}` : `Create ${path}`);
    const commit = makeCommit(repo, newTree, tip === null ? [] : [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return ok(existing !== undefined ? 200 : 201, {
      content: { name: path.split('/').pop(), path, sha: blobOid, size: data.length, type: 'file', encoding: 'base64', content: data.toString('base64') },
      commit: { sha: commit, message },
    });
  }

  if (method === 'DELETE') {
    const branch = str(body, 'branch') ?? repo.defaultBranch;
    const tip = branchTip(repo, branch);
    if (tip === null) return err(404, 'Not Found');
    const baseTree = commitTree(repo, tip) ?? emptyTree(repo);
    const flat = flattenTree(repo, baseTree);
    const existing = flat.get(path);
    if (existing === undefined) return err(404, 'Not Found');
    const givenSha = str(body, 'sha');
    if (givenSha !== null && givenSha !== existing.oid) return err(409, 'Conflict: the sha does not match the current file');
    flat.delete(path);
    const newTree = treeFromFlat(repo, flat);
    const message = str(body, 'message') ?? `Delete ${path}`;
    const commit = makeCommit(repo, newTree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return ok(200, { content: null, commit: { sha: commit, message } });
  }

  return err(404, 'Not Found');
}

/** A directory listing for the tree at `prefix` ('' is the root). */
function dirListing(repo: Repo, treeOid: string, prefix: string): Array<Record<string, unknown>> {
  const flat = flattenTree(repo, treeOid);
  const entries = new Map<string, { type: string; sha: string }>();
  const head = prefix === '' ? '' : `${prefix}/`;
  for (const [path, entry] of flat) {
    if (!path.startsWith(head)) continue;
    const rest = path.slice(head.length);
    const slash = rest.indexOf('/');
    if (slash === -1) entries.set(rest, { type: 'file', sha: entry.oid });
    else if (!entries.has(rest.slice(0, slash))) entries.set(rest.slice(0, slash), { type: 'dir', sha: '' });
  }
  return [...entries.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([name, entry]) => ({ type: entry.type, name, path: head + name, sha: entry.sha }));
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

function labelRoutes(repo: Repo, method: string, segments: string[], body: Record<string, unknown>): RestReply {
  if (segments.length !== 0) return err(404, 'Not Found');
  if (method === 'GET') {
    return ok(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
  }
  if (method === 'POST') {
    const name = str(body, 'name');
    if (name === null || name === '') return err(422, 'Label creation failed: name is required');
    if (repo.labels.has(name)) return err(422, `Label '${name}' already exists`);
    const color = (str(body, 'color') ?? 'ededed').replace(/^#/, '');
    repo.labels.set(name, { name, color });
    return ok(201, { name, color, default: false });
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Issues and comments
// ---------------------------------------------------------------------------

function issueRoutes(forge: Forge, repo: Repo, method: string, segments: string[], query: URLSearchParams, body: Record<string, unknown>): RestReply {
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const { page, headers } = paginate(issues.map((issue) => issueJson(forge, repo, issue)), query, '');
      return ok(200, page, headers);
    }
    if (method === 'POST') {
      const title = str(body, 'title');
      if (title === null || title === '') return err(422, 'Issue creation failed: title is required');
      const labels = labelNames(body);
      if (labels === null) return err(422, 'Issue creation failed: labels must be names');
      for (const name of labels) {
        if (!repo.labels.has(name)) return err(422, `Issue creation failed: label '${name}' does not exist`);
      }
      const issue = createIssue(forge, repo, { title, body: str(body, 'body') ?? '', labels });
      return ok(201, issueJson(forge, repo, issue));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(segments[0]!, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (issue === undefined) return err(404, 'Not Found');

  if (segments.length === 1) {
    if (method === 'GET') return ok(200, issueJson(forge, repo, issue));
    if (method === 'PATCH') {
      const state = str(body, 'state');
      if (state === 'open' || state === 'closed') issue.state = state;
      const title = str(body, 'title');
      if (title !== null) issue.title = title;
      const text = str(body, 'body');
      if (text !== null) issue.body = text;
      const labels = labelNames(body);
      if (labels !== null) {
        for (const name of labels) if (!repo.labels.has(name)) return err(422, `Label '${name}' does not exist`);
        issue.labels = labels;
      }
      return ok(200, issueJson(forge, repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (segments.length === 2 && segments[1] === 'comments') {
    if (method === 'GET') return ok(200, issue.comments.map((comment) => commentJson(forge, comment)));
    if (method === 'POST') {
      const text = str(body, 'body');
      if (text === null) return err(422, 'Comment creation failed: body is required');
      const comment = addComment(forge, issue, text);
      return ok(201, commentJson(forge, comment));
    }
  }
  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

/** A head/base value as a bare branch name (an "owner:branch" prefix is dropped). */
function bareBranch(value: string): string {
  const colon = value.indexOf(':');
  return colon === -1 ? value : value.slice(colon + 1);
}

function pullRoutes(forge: Forge, repo: Repo, method: string, segments: string[], query: URLSearchParams, body: Record<string, unknown>): RestReply {
  if (segments.length === 0) {
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return ok(200, pulls.map((pull) => pullJson(forge, repo, pull)));
    }
    if (method === 'POST') {
      const title = str(body, 'title');
      const headRaw = str(body, 'head');
      const baseRaw = str(body, 'base');
      if (title === null || headRaw === null || baseRaw === null) return err(422, 'Pull request creation failed: title, head and base are required');
      const head = bareBranch(headRaw);
      const base = bareBranch(baseRaw);
      if (branchTip(repo, head) === null) return err(422, `Pull request creation failed: head branch '${head}' does not exist`);
      if (branchTip(repo, base) === null) return err(422, `Pull request creation failed: base branch '${base}' does not exist`);
      if (openPullFor(repo, head, base) !== null) {
        return err(422, `A pull request already exists for ${repo.owner}:${head} -> ${repo.owner}:${base}`);
      }
      const pull = createPull(forge, repo, { title, body: str(body, 'body') ?? '', headRef: head, baseRef: base });
      return ok(201, pullJson(forge, repo, pull));
    }
    return err(404, 'Not Found');
  }

  const number = Number.parseInt(segments[0]!, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) return err(404, 'Not Found');

  if (segments.length === 1) {
    if (method === 'GET') return ok(200, pullJson(forge, repo, pull));
    if (method === 'PATCH') {
      const title = str(body, 'title');
      if (title !== null) pull.title = title;
      const text = str(body, 'body');
      if (text !== null) pull.body = text;
      const state = str(body, 'state');
      if (state === 'closed' && !pull.merged) pull.state = 'closed';
      if (state === 'open' && !pull.merged) pull.state = 'open';
      return ok(200, pullJson(forge, repo, pull));
    }
    return err(404, 'Not Found');
  }

  if (segments.length === 2 && segments[1] === 'files' && method === 'GET') {
    return ok(200, pullFiles(repo, pull).map((file) => ({ filename: file.filename, status: file.status, additions: file.additions, deletions: file.deletions, changes: file.changes })));
  }

  if (segments.length === 2 && segments[1] === 'merge' && method === 'PUT') {
    const result = mergePull(forge, repo, pull);
    if (!result.ok) {
      if (result.reason === 'conflict') return err(405, 'Pull Request is not mergeable: the head branch conflicts with the base');
      return err(405, 'Pull Request is not mergeable');
    }
    return ok(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Git data routes (refs, branches, commits)
// ---------------------------------------------------------------------------

function gitRoutes(repo: Repo, method: string, segments: string[], body: Record<string, unknown>): RestReply {
  if (segments[0] !== 'refs') return err(404, 'Not Found');
  if (segments.length === 1 && method === 'POST') {
    const ref = str(body, 'ref');
    const sha = str(body, 'sha');
    if (ref === null || sha === null || !ref.startsWith('refs/')) return err(422, 'ref and sha are required');
    const target = repo.objects.get(sha);
    if (target === undefined || target.type !== 'commit') return err(422, `sha ${sha} is not a commit in this repository`);
    if (repo.refs.has(ref)) return err(422, `Reference ${ref} already exists`);
    repo.refs.set(ref, sha);
    return ok(201, { ref, object: { sha, type: 'commit' } });
  }
  if (segments.length >= 3 && segments[1] === 'heads') {
    const branch = segments.slice(2).join('/');
    const sha = branchTip(repo, branch);
    if (sha === null) return err(404, 'Not Found');
    if (method === 'GET') return ok(200, { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } });
  }
  return err(404, 'Not Found');
}

function branchRoutes(repo: Repo, method: string, segments: string[]): RestReply {
  if (method !== 'GET') return err(404, 'Not Found');
  if (segments.length === 0) {
    const branches: Array<Record<string, unknown>> = [];
    for (const ref of [...repo.refs.keys()].sort()) {
      if (!ref.startsWith('refs/heads/')) continue;
      branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: repo.refs.get(ref) }, protected: false });
    }
    return ok(200, branches);
  }
  const branch = segments.join('/');
  const sha = branchTip(repo, branch);
  if (sha === null) return err(404, 'Not Found');
  return ok(200, { name: branch, commit: { sha }, protected: false });
}

function commitList(repo: Repo, query: URLSearchParams): RestReply {
  const tip = resolveRef(repo, query.get('sha'));
  if (tip === null) return ok(200, []);
  const commits = listCommits(repo, tip).map((oid) => {
    const obj = repo.objects.get(oid)!;
    const info = parseCommit(obj.data);
    return {
      sha: oid,
      commit: { message: info.message, tree: { sha: info.tree } },
      parents: info.parents.map((parent) => ({ sha: parent })),
    };
  });
  const { page, headers } = paginate(commits, query, '');
  return ok(200, page, headers);
}
