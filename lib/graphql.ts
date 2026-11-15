// The GraphQL surface at /api/graphql: a small parser and executor for the document shapes gh and
// github-mcp-server send (named operations, variables, aliases, inline fragments, input objects,
// enum lists), over the same store as REST. Introspection answers the field and enum lists the rules
// name; an unknown field is a 200 with an errors array naming it, an unknown repository is
// data.repository = null with no errors, and a JSON array body is answered with an array of envelopes
// in order.

import {
  addComment,
  branchTip,
  commentGlobalId,
  createIssue,
  createPull,
  issueGlobalId,
  mergePull,
  openPullFor,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  repoByGlobalId,
  repoGlobalId,
  parseGlobalId,
} from './records.ts';
import type { Forge, IssueRecord, PullRecord, Repo } from './store.ts';

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type Token = { kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[A-Za-z_]/.test(c);
  const isNameChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (input.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=@|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (input.startsWith('"""', i)) {
        const end = input.indexOf('"""', i + 3);
        const text = end === -1 ? input.slice(i + 3) : input.slice(i + 3, end);
        tokens.push({ kind: 'string', value: text });
        i = end === -1 ? input.length : end + 3;
        continue;
      }
      let j = i + 1;
      let text = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          text += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc;
          j += 2;
        } else {
          text += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: text });
      i = j + 1;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      while (j < input.length && /[0-9.eE+-]/.test(input[j]!)) j += 1;
      tokens.push({ kind: 'number', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in the GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  name: string;
  alias: string | null;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string; selection: SelectionNode[] };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, { typeCondition: string; selection: SelectionNode[] }>;
}

class Parser {
  private tokens: Token[];
  private pos = 0;

  constructor(input: string) {
    this.tokens = lex(input);
  }

  private peek(): Token {
    return this.tokens[this.pos]!;
  }

  private next(): Token {
    const token = this.tokens[this.pos]!;
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', found '${token.value}'`);
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, { typeCondition: string; selection: SelectionNode[] }>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ operation: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.atPunct('(')) this.skipVariableDefinitions();
        this.skipDirectives();
        operations.push({ operation: token.value, name, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('a fragment needs a type condition');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token '${token.value}' at the top level`);
      }
    }
    return { operations, fragments };
  }

  private skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const token = this.next();
      if (token.kind === 'eof') throw new Error('unterminated variable definitions');
      if (token.kind === 'punct' && token.value === '(') depth += 1;
      if (token.kind === 'punct' && token.value === ')') depth -= 1;
    }
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.next(); // the directive name
      if (this.atPunct('(')) {
        this.expectPunct('(');
        let depth = 1;
        while (depth > 0) {
          const token = this.next();
          if (token.kind === 'eof') throw new Error('unterminated directive arguments');
          if (token.kind === 'punct' && token.value === '(') depth += 1;
          if (token.kind === 'punct' && token.value === ')') depth -= 1;
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new Error('unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.peek().kind === 'spread') {
      this.next();
      if (this.peek().kind === 'name' && this.peek().value === 'on') {
        this.next();
        const typeCondition = this.next().value;
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selection: this.parseSelectionSet() };
      }
      const name = this.next().value;
      this.skipDirectives();
      return { kind: 'spread', name };
    }
    return { kind: 'field', field: this.parseField() };
  }

  private parseField(): FieldNode {
    let name = this.next().value;
    let alias: string | null = null;
    if (this.atPunct(':')) {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = new Map<string, Value>();
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        const argName = this.next().value;
        this.expectPunct(':');
        args.set(argName, this.parseValue());
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.atPunct('{')) selection = this.parseSelectionSet();
    return { name, alias, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.atPunct(']')) items.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields = new Map<string, Value>();
      while (!this.atPunct('}')) {
        const key = this.next().value;
        this.expectPunct(':');
        fields.set(key, this.parseValue());
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token '${token.value}'`);
  }
}

// ---------------------------------------------------------------------------
// Schema description (introspection data)
// ---------------------------------------------------------------------------

interface TypeInfo {
  kind: 'OBJECT' | 'ENUM' | 'INPUT_OBJECT' | 'SCALAR';
  fields?: string[];
  enumValues?: string[];
}

const TYPE_INFO: Record<string, TypeInfo> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', 'search', 'rateLimit'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'reopenIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'name', 'email'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'description', 'isPrivate', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'labels', 'createdAt', 'url'],
  },
  Issue: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'labels', 'comments', 'repository', 'author', 'createdAt', 'url', 'closed'],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeCommit', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeable', 'files', 'repository', 'author', 'createdAt', 'url', 'isDraft'],
  },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'databaseId', 'body', 'author', 'createdAt'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color'] },
  Ref: { kind: 'OBJECT', fields: ['id', 'name', 'prefix', 'target'] },
  Commit: { kind: 'OBJECT', fields: ['id', 'oid', 'message', 'tree'] },
  Tree: { kind: 'OBJECT', fields: ['id', 'oid'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestFileConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  PullRequestFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'pageInfo', 'totalCount'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'issueCount', 'repositoryCount', 'userCount'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  ReopenIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  SearchType: { kind: 'ENUM', enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'] },
  IssueOrderField: { kind: 'ENUM', enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', enumValues: ['ASC', 'DESC'] },
  PullRequestMergeMethod: { kind: 'ENUM', enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  String: { kind: 'SCALAR' },
  Int: { kind: 'SCALAR' },
  Boolean: { kind: 'SCALAR' },
  ID: { kind: 'SCALAR' },
  URI: { kind: 'SCALAR' },
  DateTime: { kind: 'SCALAR' },
};

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

type Node =
  | { gql: 'User' }
  | { gql: 'Repository'; repo: Repo }
  | { gql: 'Issue'; repo: Repo; issue: IssueRecord }
  | { gql: 'PullRequest'; repo: Repo; pull: PullRecord }
  | { gql: 'IssueComment'; repo: Repo; issue: IssueRecord; comment: { id: number; body: string } }
  | { gql: 'Label'; name: string; color: string }
  | { gql: 'Ref'; name: string; oid: string | null }
  | { gql: 'Commit'; oid: string }
  | { gql: string; props: Record<string, unknown> };

interface ExecContext {
  forge: Forge;
  doc: DocumentNode;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function resolveValue(value: Value, ctx: ExecContext): unknown {
  switch (value.kind) {
    case 'variable':
      return ctx.variables[value.name] ?? null;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of field.args) out[key] = resolveValue(value, ctx);
  return out;
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number.parseInt(match[1]!, 10);
  } catch {
    return -1;
  }
}

/** Slice a node list into a connection shape with pageInfo. */
function connection(nodes: unknown[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? Math.max(0, Math.floor(args.first)) : nodes.length;
  const afterIndex = indexFromCursor(args.after);
  const start = afterIndex + 1;
  const slice = nodes.slice(start, start + first);
  const hasNextPage = start + slice.length < nodes.length;
  return {
    nodes: slice,
    edges: slice.map((node, i) => ({ gql: 'ConnectionEdge', props: { node, cursor: cursorFor(start + i) } })),
    pageInfo: {
      gql: 'PageInfo',
      props: {
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: slice.length > 0 ? cursorFor(start) : null,
        endCursor: slice.length > 0 ? cursorFor(start + slice.length - 1) : null,
      },
    },
    totalCount: nodes.length,
    issueCount: nodes.length,
    repositoryCount: 0,
    userCount: 0,
  };
}

function issueState(issue: IssueRecord): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullState(pull: PullRecord): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

/** The field map of one object type. Returning undefined marks an unknown field. */
function resolveField(ctx: ExecContext, typeName: string, source: Node | Record<string, unknown> | null, field: FieldNode): unknown {
  const forge = ctx.forge;
  const args = argsOf(field, ctx);
  const node = source as Node | null;

  if (typeName === 'Query') {
    switch (field.name) {
      case 'viewer':
        return { gql: 'User' } satisfies Node;
      case 'repository': {
        const repo = typeof args.owner === 'string' && typeof args.name === 'string' ? forge.repo(args.owner, args.name) : null;
        return repo === null ? null : ({ gql: 'Repository', repo } satisfies Node);
      }
      case 'node': {
        return typeof args.id === 'string' ? nodeByGlobalId(forge, args.id) : null;
      }
      case 'search': {
        const type = typeof args.type === 'string' ? args.type : 'ISSUE';
        const text = typeof args.query === 'string' ? args.query.toLowerCase() : '';
        const found: Node[] = [];
        if (type === 'ISSUE') {
          for (const repo of forge.allRepos()) {
            for (const issue of repo.issues.values()) {
              if (text === '' || issue.title.toLowerCase().includes(text)) found.push({ gql: 'Issue', repo, issue });
            }
          }
        }
        return { gql: 'SearchResultItemConnection', props: connection(found, args) };
      }
      case 'rateLimit':
        return { gql: 'RateLimit', props: { limit: 5000, cost: 1, remaining: 4999, resetAt: '2026-01-01T00:00:00Z' } };
      case '__type': {
        const name = typeof args.name === 'string' ? args.name : '';
        const info = TYPE_INFO[name];
        if (info === undefined) return null;
        return {
          gql: '__Type',
          props: {
            name,
            kind: info.kind,
            description: null,
            fields: (info.fields ?? []).map((fieldName) => ({
              gql: '__Field',
              props: { name: fieldName, description: null, args: [], type: { gql: '__Type', props: { name: 'String', kind: 'SCALAR' } }, isDeprecated: false, deprecationReason: null },
            })),
            enumValues: (info.enumValues ?? []).map((value) => ({ gql: '__EnumValue', props: { name: value, description: null, isDeprecated: false, deprecationReason: null } })),
            possibleTypes: null,
            inputFields: null,
            interfaces: [],
            specifiedByURL: null,
          },
        };
      }
      case '__schema':
        return {
          gql: '__Schema',
          props: {
            queryType: { gql: '__Type', props: { name: 'Query', kind: 'OBJECT' } },
            mutationType: { gql: '__Type', props: { name: 'Mutation', kind: 'OBJECT' } },
            subscriptionType: null,
            types: Object.keys(TYPE_INFO).map((name) => ({ gql: '__Type', props: { name, kind: TYPE_INFO[name]!.kind } })),
            directives: [],
          },
        };
      default:
        return undefined;
    }
  }

  if (typeName === 'Mutation') return resolveMutation(ctx, field, args);

  // Plain payload/connection/introspection nodes resolve straight from their property bag.
  const props = source !== null && typeof source === 'object' && 'props' in source ? (source as { props: Record<string, unknown> }).props : null;
  if (props !== null) {
    return field.name in props ? props[field.name] : undefined;
  }

  if (node === null) return undefined;

  switch (node.gql) {
    case 'User':
      switch (field.name) {
        case 'id':
          return Buffer.from(`User:${forge.viewer.id}`, 'utf8').toString('base64');
        case 'databaseId':
          return forge.viewer.id;
        case 'login':
          return forge.viewer.login;
        case 'name':
          return forge.viewer.name;
        case 'email':
          return forge.viewer.email;
        default:
          return undefined;
      }
    case 'Repository':
      return resolveRepository(ctx, node.repo, field, args);
    case 'Issue': {
      const { repo, issue } = node;
      switch (field.name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'databaseId':
          return issue.id;
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'body':
          return issue.body;
        case 'state':
          return issueState(issue);
        case 'closed':
          return issue.state === 'closed';
        case 'repository':
          return { gql: 'Repository', repo } satisfies Node;
        case 'author':
          return { gql: 'User' } satisfies Node;
        case 'createdAt':
          return issue.createdAt;
        case 'labels':
          return { gql: 'LabelConnection', props: connection(issue.labels.map((name) => ({ gql: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })), args) };
        case 'comments':
          return { gql: 'IssueCommentConnection', props: connection(issue.comments.map((comment) => ({ gql: 'IssueComment', repo, issue, comment })), args) };
        default:
          return undefined;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = node;
      switch (field.name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'databaseId':
          return pull.id;
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'mergedAt':
          return pull.mergedAt;
        case 'mergeCommit':
          return pull.mergeCommitSha === null ? null : ({ gql: 'Commit', oid: pull.mergeCommitSha } satisfies Node);
        case 'headRefName':
          return pull.headRef;
        case 'baseRefName':
          return pull.baseRef;
        case 'headRef': {
          const tip = branchTip(repo, pull.headRef);
          return tip === null ? null : ({ gql: 'Ref', name: pull.headRef, oid: tip } satisfies Node);
        }
        case 'baseRef': {
          const tip = branchTip(repo, pull.baseRef);
          return tip === null ? null : ({ gql: 'Ref', name: pull.baseRef, oid: tip } satisfies Node);
        }
        case 'mergeable':
          return pullMergeable(repo, pull);
        case 'isDraft':
          return false;
        case 'repository':
          return { gql: 'Repository', repo } satisfies Node;
        case 'author':
          return { gql: 'User' } satisfies Node;
        case 'createdAt':
          return pull.createdAt;
        case 'files': {
          const files = pullFiles(repo, pull).map((file) => ({
            gql: 'PullRequestFile',
            props: { path: file.filename, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' },
          }));
          return { gql: 'PullRequestFileConnection', props: connection(files, args) };
        }
        default:
          return undefined;
      }
    }
    case 'IssueComment':
      switch (field.name) {
        case 'id':
          return commentGlobalId(node.repo, node.issue, node.comment);
        case 'databaseId':
          return node.comment.id;
        case 'body':
          return node.comment.body;
        case 'author':
          return { gql: 'User' } satisfies Node;
        default:
          return undefined;
      }
    case 'Label':
      switch (field.name) {
        case 'id':
          return Buffer.from(`Label:${node.name}`, 'utf8').toString('base64');
        case 'name':
          return node.name;
        case 'color':
          return node.color;
        default:
          return undefined;
      }
    case 'Ref':
      switch (field.name) {
        case 'id':
          return Buffer.from(`Ref:${node.name}`, 'utf8').toString('base64');
        case 'name':
          return node.name;
        case 'prefix':
          return 'refs/heads/';
        case 'target':
          return node.oid === null ? null : ({ gql: 'Commit', oid: node.oid } satisfies Node);
        default:
          return undefined;
      }
    case 'Commit':
      switch (field.name) {
        case 'id':
          return Buffer.from(`Commit:${node.oid}`, 'utf8').toString('base64');
        case 'oid':
          return node.oid;
        default:
          return undefined;
      }
    default:
      return undefined;
  }
}

function resolveRepository(ctx: ExecContext, repo: Repo, field: FieldNode, args: Record<string, unknown>): unknown {
  switch (field.name) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'isPrivate':
      return repo.isPrivate;
    case 'owner':
      return { gql: 'User' } satisfies Node;
    case 'defaultBranchRef': {
      const tip = branchTip(repo, repo.defaultBranch);
      return tip === null ? null : ({ gql: 'Ref', name: repo.defaultBranch, oid: tip } satisfies Node);
    }
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'createdAt':
      return repo.createdAt;
    case 'issue': {
      const number = typeof args.number === 'number' ? args.number : null;
      const issue = number === null ? undefined : repo.issues.get(number);
      return issue === undefined ? null : ({ gql: 'Issue', repo, issue } satisfies Node);
    }
    case 'issues': {
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) issues = issues.filter((issue) => states.includes(issueState(issue)));
      const orderBy = args.orderBy !== null && typeof args.orderBy === 'object' ? (args.orderBy as Record<string, unknown>) : null;
      const descending = orderBy !== null && orderBy.direction === 'DESC';
      issues.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      const nodes: Node[] = issues.map((issue) => ({ gql: 'Issue', repo, issue }));
      return { gql: 'IssueConnection', props: connection(nodes, args) };
    }
    case 'pullRequest': {
      const number = typeof args.number === 'number' ? args.number : null;
      const pull = number === null ? undefined : repo.pulls.get(number);
      return pull === undefined ? null : ({ gql: 'PullRequest', repo, pull } satisfies Node);
    }
    case 'pullRequests': {
      let pulls = [...repo.pulls.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).map(String) : null;
      if (states !== null) pulls = pulls.filter((pull) => states.includes(pullState(pull)));
      else pulls = pulls.filter((pull) => pull.state === 'open');
      pulls.sort((a, b) => a.number - b.number);
      const nodes: Node[] = pulls.map((pull) => ({ gql: 'PullRequest', repo, pull }));
      return { gql: 'PullRequestConnection', props: connection(nodes, args) };
    }
    case 'labels': {
      const nodes: Node[] = [...repo.labels.values()].map((label) => ({ gql: 'Label', name: label.name, color: label.color }));
      return { gql: 'LabelConnection', props: connection(nodes, args) };
    }
    default:
      return undefined;
  }
}

/** Find the repository and record a global id names (node field and mutation inputs). */
function nodeByGlobalId(forge: Forge, id: string): Node | null {
  const parsed = parseGlobalId(id);
  if (parsed === null) return null;
  if (parsed.kind === 'Repository') {
    const repo = repoByGlobalId(forge, id);
    return repo === null ? null : { gql: 'Repository', repo };
  }
  if (parsed.kind === 'Issue' || parsed.kind === 'PullRequest') {
    const repoId = Number.parseInt(parsed.parts[0]!, 10);
    const number = Number.parseInt(parsed.parts[1]!, 10);
    const repo = forge.allRepos().find((candidate) => candidate.id === repoId);
    if (repo === undefined) return null;
    if (parsed.kind === 'Issue') {
      const issue = repo.issues.get(number);
      return issue === undefined ? null : { gql: 'Issue', repo, issue };
    }
    const pull = repo.pulls.get(number);
    return pull === undefined ? null : { gql: 'PullRequest', repo, pull };
  }
  return null;
}

function resolveMutation(ctx: ExecContext, field: FieldNode, args: Record<string, unknown>): unknown {
  const forge = ctx.forge;
  const input = args.input !== null && typeof args.input === 'object' ? (args.input as Record<string, unknown>) : args;
  const payload = (gql: string, props: Record<string, unknown>): Node => ({ gql, props });
  switch (field.name) {
    case 'createIssue': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(forge, input.repositoryId) : null;
      if (repo === null) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return payload('CreateIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      const issue = createIssue(forge, repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      return payload('CreateIssuePayload', { issue: { gql: 'Issue', repo, issue } satisfies Node, clientMutationId: input.clientMutationId ?? null });
    }
    case 'closeIssue':
    case 'reopenIssue': {
      const target = typeof input.issueId === 'string' ? nodeByGlobalId(forge, input.issueId) : null;
      if (target === null || target.gql !== 'Issue') {
        ctx.errors.push({ message: 'issueId does not name an issue' });
        return payload(field.name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: null, clientMutationId: input.clientMutationId ?? null });
      }
      target.issue.state = field.name === 'closeIssue' ? 'closed' : 'open';
      return payload(field.name === 'closeIssue' ? 'CloseIssuePayload' : 'ReopenIssuePayload', { issue: target, clientMutationId: input.clientMutationId ?? null });
    }
    case 'createPullRequest': {
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(forge, input.repositoryId) : null;
      const headRefName = String(input.headRefName ?? '');
      const baseRefName = String(input.baseRefName ?? '');
      if (repo === null) {
        ctx.errors.push({ message: 'repositoryId does not name a repository' });
        return payload('CreatePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const existing = openPullFor(repo, headRefName, baseRefName);
      if (existing !== null) {
        return payload('CreatePullRequestPayload', { pullRequest: { gql: 'PullRequest', repo, pull: existing } satisfies Node, clientMutationId: input.clientMutationId ?? null });
      }
      const pull = createPull(forge, repo, { title: String(input.title ?? ''), body: String(input.body ?? ''), headRef: headRefName, baseRef: baseRefName });
      return payload('CreatePullRequestPayload', { pullRequest: { gql: 'PullRequest', repo, pull } satisfies Node, clientMutationId: input.clientMutationId ?? null });
    }
    case 'mergePullRequest': {
      const target = typeof input.pullRequestId === 'string' ? nodeByGlobalId(forge, input.pullRequestId) : null;
      if (target === null || target.gql !== 'PullRequest') {
        ctx.errors.push({ message: 'pullRequestId does not name a pull request' });
        return payload('MergePullRequestPayload', { pullRequest: null, clientMutationId: input.clientMutationId ?? null });
      }
      const result = mergePull(forge, target.repo, target.pull);
      if (!result.ok && result.reason === 'conflict') ctx.errors.push({ message: 'the pull request has conflicts and cannot be merged' });
      return payload('MergePullRequestPayload', { pullRequest: target, clientMutationId: input.clientMutationId ?? null });
    }
    case 'addComment': {
      const target = typeof input.subjectId === 'string' ? nodeByGlobalId(forge, input.subjectId) : null;
      if (target === null || target.gql !== 'Issue') {
        ctx.errors.push({ message: 'subjectId does not name an issue' });
        return payload('AddCommentPayload', { commentEdge: null, subject: null, clientMutationId: input.clientMutationId ?? null });
      }
      const comment = addComment(forge, target.issue, String(input.body ?? ''));
      const node: Node = { gql: 'IssueComment', repo: target.repo, issue: target.issue, comment };
      return payload('AddCommentPayload', {
        commentEdge: { gql: 'IssueCommentEdge', props: { node, cursor: cursorFor(target.issue.comments.length - 1) } },
        subject: target,
        clientMutationId: input.clientMutationId ?? null,
      });
    }
    default:
      return undefined;
  }
}

/** The GraphQL type name a node value carries (for fragment conditions and error messages). */
function typeNameOf(value: unknown): string {
  if (value !== null && typeof value === 'object' && 'gql' in value) return String((value as { gql: unknown }).gql);
  return 'Unknown';
}

/** Execute a selection set against a typed source value. */
function executeSelection(ctx: ExecContext, typeName: string, source: unknown, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.doc.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== typeName && fragment.typeCondition !== 'Node') continue;
      Object.assign(out, executeSelection(ctx, typeName, source, fragment.selection));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== typeName) continue;
      Object.assign(out, executeSelection(ctx, typeName, source, selection.selection));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const value = resolveField(ctx, typeName, source as Node, field);
    if (value === undefined) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(ctx, value, field);
  }
  return out;
}

/** Turn a resolved field value into its response shape, recursing into objects and lists. */
function completeValue(ctx: ExecContext, value: unknown, field: FieldNode): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(ctx, item, field));
  if (typeof value === 'object') {
    if (field.selection === null) return value;
    return executeSelection(ctx, typeNameOf(value), value, field.selection);
  }
  return value;
}

/** Execute one GraphQL operation object; returns the response envelope. */
export function executeGraphQL(forge: Forge, operation: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> {
  const query = typeof operation.query === 'string' ? operation.query : '';
  let doc: DocumentNode;
  try {
    doc = new Parser(query).parseDocument();
  } catch (error) {
    return { errors: [{ message: error instanceof Error ? error.message : 'the document did not parse' }] };
  }
  const variables = operation.variables !== null && typeof operation.variables === 'object' ? (operation.variables as Record<string, unknown>) : {};
  const opName = typeof operation.operationName === 'string' ? operation.operationName : null;
  const op = (opName !== null ? doc.operations.find((candidate) => candidate.name === opName) : undefined) ?? doc.operations[0];
  if (op === undefined) return { errors: [{ message: 'no operation in the document' }] };
  const ctx: ExecContext = { forge, doc, variables, errors: [] };
  const rootType = op.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(ctx, rootType, { gql: rootType, props: {} }, op.selection);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}
