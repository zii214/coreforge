// The MCP endpoint at /mcp: JSON-RPC 2.0 over Streamable HTTP. It speaks the modern revision
// (server/discover answers a DiscoverResult whose supportedVersions names 2026-07-28) and the legacy
// handshake (initialize echoes a 2025-era revision). The tools act on the same store as REST — the
// serializers in records.ts shape every answer, so an object created here reads back over /api/v3
// unchanged. Handling is fully synchronous per request, so concurrent calls can never cross ids or
// arguments.

import { branchTip, createIssue, createPull, issueJson, mergePull, openPullFor, pullJson, repoJson } from './records.ts';
import type { Forge, Repo } from './store.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'];
const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string; items?: { type: string } }>;
  required: string[];
}

/** The tool catalogue. Property names are the canonical github-mcp-server spellings. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user and return the repository object.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login (defaults to the authenticated user).' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name and return the repository object.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: [],
  },
  {
    name: 'list_repos',
    description: 'List the repositories the authenticated user owns.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login (defaults to the authenticated user).' },
    },
    required: [],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository and return the issue object.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
      labels: { type: 'array', description: 'Label names to apply (each must already exist).', items: { type: 'string' } },
    },
    required: [],
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state (open, closed or all).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'The issue state filter: open, closed or all.' },
    },
    required: [],
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch and return the pull request object.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: [],
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number and return the merged pull request object.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: [],
  },
];

/** tools/list's answer, built once so repeated calls are byte-identical. */
const TOOLS_LIST_RESULT = {
  tools: TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: { type: 'object', properties: tool.properties, required: tool.required },
  })),
};

export interface McpReply {
  status: number;
  /** The JSON-RPC envelope to serialize, or null for an empty answer (notifications). */
  body: unknown | null;
}

type Args = Record<string, unknown>;

/** Read a string argument under any of its accepted spellings. */
function argStr(args: Args, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return null;
}

/** Read a numeric argument under any of its accepted spellings. */
function argNum(args: Args, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

/** Resolve owner/repo arguments, honoring a full_name of "owner/repo" when present. */
function repoArgs(forge: Forge, args: Args): { owner: string; repo: string } {
  let owner = argStr(args, 'owner', 'owner_login', 'org', 'user', 'login');
  let repo = argStr(args, 'repo', 'repository', 'repo_name', 'project', 'name');
  const fullName = argStr(args, 'full_name', 'fullName');
  if (fullName !== null && fullName.includes('/')) {
    const [namedOwner, namedRepo] = fullName.split('/', 2);
    if (owner === null && namedOwner !== '') owner = namedOwner;
    if (repo === null && namedRepo !== '') repo = namedRepo;
    else if (repo === null) repo = namedRepo ?? null;
  }
  return { owner: owner ?? forge.viewer.login, repo: repo ?? '' };
}

/** A tool result carrying one JSON object in both a text block and structuredContent. */
function toolOk(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  };
}

/** A tool-level failure (the call was well-formed; the operation was not possible). */
function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: message }],
    isError: true,
  };
}

type CallOutcome = { result: Record<string, unknown> } | { rpcError: { code: number; message: string } };

function invalidParams(message: string): CallOutcome {
  return { rpcError: { code: -32602, message } };
}

/** Run one tools/call. */
function callTool(forge: Forge, name: string, args: Args): CallOutcome {
  const tool = TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) return invalidParams(`unknown tool: ${name}`);
  switch (tool.name) {
    case 'create_repo': {
      const repoName = argStr(args, 'name', 'repo', 'repository');
      if (repoName === null) return invalidParams('create_repo requires a repository name');
      const existing = forge.repo(forge.viewer.login, repoName);
      if (existing !== null) return { result: toolOk(repoJson(forge, existing)) };
      const description = argStr(args, 'description') ?? '';
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = forge.createRepo(repoName, description, isPrivate);
      return { result: toolOk(repoJson(forge, repo)) };
    }
    case 'get_repo': {
      const { owner, repo } = repoArgs(forge, args);
      if (repo === '') return invalidParams('get_repo requires a repository name');
      const found = forge.repo(owner, repo);
      if (found === null) return { result: toolError(`repository ${owner}/${repo} not found`) };
      return { result: toolOk(repoJson(forge, found)) };
    }
    case 'list_repos': {
      return { result: toolOk({ repositories: forge.allRepos().map((repo) => repoJson(forge, repo)) }) };
    }
    case 'create_issue': {
      const { owner, repo } = repoArgs(forge, args);
      const title = argStr(args, 'title');
      if (repo === '' || title === null) return invalidParams('create_issue requires owner, repo and title');
      const found = forge.repo(owner, repo);
      if (found === null) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!found.labels.has(label)) return { result: toolError(`label '${label}' does not exist`) };
      }
      const issue = createIssue(forge, found, { title, body: argStr(args, 'body') ?? '', labels });
      return { result: toolOk(issueJson(forge, found, issue)) };
    }
    case 'list_issues': {
      const { owner, repo } = repoArgs(forge, args);
      if (repo === '') return invalidParams('list_issues requires a repository name');
      const found = forge.repo(owner, repo);
      if (found === null) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const state = argStr(args, 'state') ?? 'open';
      let issues = [...found.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      return { result: toolOk({ issues: issues.map((issue) => issueJson(forge, found, issue)) }) };
    }
    case 'create_pull_request': {
      const { owner, repo } = repoArgs(forge, args);
      const title = argStr(args, 'title');
      const head = argStr(args, 'head', 'head_ref', 'source_branch', 'from_branch');
      const base = argStr(args, 'base', 'base_ref', 'target_branch', 'into_branch');
      if (repo === '' || title === null || head === null || base === null) {
        return invalidParams('create_pull_request requires owner, repo, title, head and base');
      }
      const found = forge.repo(owner, repo);
      if (found === null) return { result: toolError(`repository ${owner}/${repo} not found`) };
      if (branchTip(found, head) === null) return { result: toolError(`head branch '${head}' does not exist`) };
      if (branchTip(found, base) === null) return { result: toolError(`base branch '${base}' does not exist`) };
      const existing = openPullFor(found, head, base);
      if (existing !== null) return { result: toolOk(pullJson(forge, found, existing)) };
      const pull = createPull(forge, found, { title, body: argStr(args, 'body') ?? '', headRef: head, baseRef: base });
      return { result: toolOk(pullJson(forge, found, pull)) };
    }
    case 'merge_pull_request': {
      const { owner, repo } = repoArgs(forge, args);
      const number = argNum(args, 'pull_number', 'pull_request_number', 'number', 'issue_number');
      if (repo === '' || number === null) return invalidParams('merge_pull_request requires owner, repo and pull_number');
      const found: Repo | null = forge.repo(owner, repo);
      if (found === null) return { result: toolError(`repository ${owner}/${repo} not found`) };
      const pull = found.pulls.get(number);
      if (pull === undefined) return { result: toolError(`pull request #${number} not found`) };
      const result = mergePull(forge, found, pull);
      if (!result.ok) return { result: toolError(`pull request #${number} could not be merged: ${result.reason}`) };
      return { result: toolOk(pullJson(forge, found, pull)) };
    }
    default:
      return invalidParams(`unknown tool: ${name}`);
  }
}

/** Dispatch one JSON-RPC request object. */
function dispatch(forge: Forge, request: Record<string, unknown>): McpReply {
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = request.params !== null && typeof request.params === 'object' ? (request.params as Record<string, unknown>) : {};
  const envelope = (result: unknown): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
  const failure = (code: number, message: string): McpReply => ({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

  switch (method) {
    case 'server/discover':
      return envelope({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = LEGACY_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return envelope({ protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return envelope({});
    case 'tools/list':
      return envelope(TOOLS_LIST_RESULT);
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const args = params.arguments !== null && typeof params.arguments === 'object' ? (params.arguments as Args) : {};
      if (name === '') return failure(-32602, 'tools/call requires a tool name');
      const outcome = callTool(forge, name, args);
      if ('rpcError' in outcome) return failure(outcome.rpcError.code, outcome.rpcError.message);
      return envelope(outcome.result);
    }
    default:
      if (method.startsWith('notifications/')) return { status: 202, body: null };
      return failure(-32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp body. A body that is not JSON is a 400 with a -32700 parse error; a
 * notification (no id) is answered 202 with no body; a batch is answered in order.
 */
export function handleMcp(forge: Forge, bodyText: string): McpReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const item of parsed) {
      if (item === null || typeof item !== 'object') continue;
      const reply = dispatch(forge, item as Record<string, unknown>);
      if (reply.body !== null) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = parsed as Record<string, unknown>;
  if (request.id === undefined && typeof request.method === 'string') {
    dispatch(forge, request);
    return { status: 202, body: null };
  }
  return dispatch(forge, request);
}
