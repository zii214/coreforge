// Git smart HTTP, implemented from the protocol up: pkt-line framing, packfiles (plain objects out,
// plain and delta objects in), protocol v2 upload-pack (capability advertisement, ls-refs, fetch),
// protocol v0 upload-pack with side-band-64k, and v0 receive-pack with report-status. There is no git
// binary anywhere in this file: the object model in store.ts is the only database.
//
// The shapes here follow the suite's own client: sections in a v2 fetch answer are self-describing, a
// v0 fetch answer is NAK/ACK and shallow pkt-lines followed by band-1 pack packets, and a push report
// is a pkt-line stream carried inside band-1 packets when side-band-64k was negotiated.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ancestorsOf,
  commitTree,
  getObject,
  parseCommit,
  peelToCommit,
  putObject,
  type Forge,
  type GitObjectType,
  type Repo,
} from './store.ts';

export const ZERO_OID = '0000000000000000000000000000000000000000';
const AGENT = 'forge/1.0';

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

/** One pkt-line: a 4-hex length prefix (counting itself) before the payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = (data.length + 4).toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parse pkt-lines from the front of `buf`; returns the packets and how many bytes they consumed. */
export function parsePkts(buf: Buffer, start = 0): { packets: Pkt[]; next: number } {
  const packets: Pkt[] = [];
  let pos = start;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      pos += 4;
      break;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      pos += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'end' });
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) throw new Error('truncated pkt-line');
    packets.push({ kind: 'data', payload: buf.subarray(pos + 4, pos + length) });
    pos += length;
  }
  return { packets, next: pos };
}

/** Split a buffer into consecutive pkt-line groups separated by flush packets (request sections). */
export function pktSections(buf: Buffer): Buffer[][] {
  const sections: Buffer[][] = [];
  let current: Buffer[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const header = buf.toString('ascii', pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      sections.push(current);
      current = [];
      pos += 4;
      continue;
    }
    if (length === 1 || length === 2) {
      pos += 4;
      continue;
    }
    if (length < 4 || pos + length > buf.length) break;
    current.push(buf.subarray(pos + 4, pos + length));
    pos += length;
  }
  if (current.length > 0) sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const TYPE_CODES: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Build a version-2 pack holding the given objects, plain (never delta) entries only. */
export function buildPack(repo: Repo, oids: string[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = getObject(repo, oid);
    if (obj === null) continue;
    let size = obj.data.length;
    const first = ((TYPE_CODES[obj.type]! & 0x07) << 4) | (size & 0x0f);
    size >>= 4;
    const headBytes: number[] = [];
    let byte = first;
    while (size > 0) {
      headBytes.push(byte | 0x80);
      byte = size & 0x7f;
      size >>= 7;
    }
    headBytes.push(byte);
    parts.push(Buffer.from(headBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate at an offset, learning how many compressed bytes the stream used. */
function inflateAt(buf: Buffer, offset: number): { data: Buffer; used: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: result.buffer, used: result.engine.bytesWritten };
}

/** Apply a git delta to its base bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[pos]!;
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size, informational here
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (pos < delta.length) {
    const cmd = delta[pos]!;
    pos += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) if (cmd & (1 << i)) { offset |= delta[pos]! << (8 * i); pos += 1; }
      for (let i = 0; i < 3; i += 1) if (cmd & (0x10 << i)) { size |= delta[pos]! << (8 * i); pos += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
    } else if (cmd !== 0) {
      out.push(delta.subarray(pos, pos + cmd));
      pos += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta produced the wrong size');
  return result;
}

interface PendingDelta {
  baseOid: string | null;
  baseOffset: number | null;
  delta: Buffer;
}

/**
 * Read a pack into the repository's object store, resolving OFS and REF deltas against the pack
 * itself and the objects already held. Returns the number of objects the pack declared.
 */
export function unpackPack(repo: Repo, buf: Buffer): number {
  if (buf.length < 12 + 20 || buf.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = buf.readUInt32BE(8);
  const trailer = buf.subarray(buf.length - 20);
  const digest = createHash('sha1').update(buf.subarray(0, buf.length - 20)).digest();
  if (!digest.equals(trailer)) throw new Error('pack checksum mismatch');
  let pos = 12;
  const byOffset = new Map<number, string>();
  const pending: Array<{ entryStart: number; delta: PendingDelta }> = [];
  const resolveDelta = (baseOid: string, delta: Buffer): string => {
    const base = getObject(repo, baseOid);
    if (base === null) throw new Error(`delta base ${baseOid} is not available`);
    return putObject(repo, base.type, applyDelta(base.data, delta));
  };
  for (let i = 0; i < count; i += 1) {
    const entryStart = pos;
    let byte = buf[pos]!;
    pos += 1;
    const typeCode = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = buf[pos]!;
      pos += 1;
    }
    let baseOid: string | null = null;
    let baseOffset: number | null = null;
    if (typeCode === 6) {
      let c = buf[pos]!;
      pos += 1;
      let offset = c & 0x7f;
      while (c & 0x80) {
        c = buf[pos]!;
        pos += 1;
        offset = ((offset + 1) << 7) | (c & 0x7f);
      }
      baseOffset = entryStart - offset;
    } else if (typeCode === 7) {
      baseOid = buf.toString('hex', pos, pos + 20);
      pos += 20;
    }
    const { data, used } = inflateAt(buf, pos);
    pos += used;
    if (typeCode === 6 || typeCode === 7) {
      pending.push({ entryStart, delta: { baseOid, baseOffset, delta: data } });
    } else {
      const type = CODE_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      byOffset.set(entryStart, putObject(repo, type, data));
    }
  }
  // Deltas resolve once their base is known; a delta may itself be another delta's base, so sweep
  // until nothing is left (each sweep must resolve at least one, else the pack is unresolvable).
  let remaining = pending;
  while (remaining.length > 0) {
    const deferred: Array<{ entryStart: number; delta: PendingDelta }> = [];
    let progressed = false;
    for (const item of remaining) {
      const base = item.delta.baseOid ?? byOffset.get(item.delta.baseOffset!);
      if (base === undefined || base === '') {
        deferred.push(item);
        continue;
      }
      byOffset.set(item.entryStart, resolveDelta(base, item.delta.delta));
      progressed = true;
    }
    if (!progressed) throw new Error('a delta base never resolved');
    remaining = deferred;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Ref advertisement
// ---------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  ref: string;
  symrefTarget?: string;
  peeled?: string;
}

/** Every ref the repository advertises, HEAD first, then branches and tags in name order. */
export function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  lines.push({ oid: headOid ?? ZERO_OID, ref: 'HEAD', symrefTarget: headTarget });
  const names = [...repo.refs.keys()].sort();
  for (const ref of names) {
    const oid = repo.refs.get(ref)!;
    const line: RefLine = { oid, ref };
    const obj = getObject(repo, oid);
    if (obj !== null && obj.type === 'tag') {
      const commit = peelToCommit(repo, oid);
      if (commit !== null) line.peeled = commit;
    }
    lines.push(line);
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: string): Buffer {
  // No multi_ack on upload-pack: fetch answers below speak plain NAK/ACK lines, which the client's
  // non-multi-ack path frames exactly. Receive-pack must name report-status, side-band-64k and
  // delete-refs (the rules require all three).
  const effectiveCaps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not object-format=sha1 agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = advertisedRefs(repo);
  refs.forEach((line, index) => {
    if (line.ref === 'HEAD' && line.oid === ZERO_OID) {
      parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${effectiveCaps}\n`));
      return;
    }
    const suffix = index === 0 ? `\0${effectiveCaps}` : '';
    parts.push(pktLine(`${line.oid} ${line.ref}${suffix}\n`));
    if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.ref}^{}\n`));
  });
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow\n', 'object-format=sha1\n'];
  return Buffer.concat([...lines.map((line) => pktLine(line)), PKT_FLUSH]);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

function lsRefs(repo: Repo, args: Buffer[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    const line = arg.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (ref: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => ref.startsWith(prefix));
  const out: Buffer[] = [];
  for (const line of advertisedRefs(repo)) {
    if (!matches(line.ref)) continue;
    if (line.ref === 'HEAD' && line.oid === ZERO_OID) {
      if (unborn) out.push(pktLine(`unborn HEAD symref-target:${line.symrefTarget}\n`));
      continue;
    }
    let text = `${line.oid} ${line.ref}`;
    if (symrefs && line.symrefTarget !== undefined) text += ` symref-target:${line.symrefTarget}`;
    if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
    out.push(pktLine(`${text}\n`));
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

// ---------------------------------------------------------------------------
// Fetch planning
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  wantRefs: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

function parseFetchArgs(args: Buffer[]): FetchArgs {
  const parsed: FetchArgs = { wants: [], wantRefs: [], haves: [], shallow: [], deepen: null, deepenSince: null, deepenNot: [] };
  for (const arg of args) {
    const line = arg.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) parsed.wants.push(line.slice(5).trim());
    else if (line.startsWith('want-ref ')) parsed.wantRefs.push(line.slice(9).trim());
    else if (line.startsWith('have ')) parsed.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) parsed.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) parsed.deepen = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) parsed.deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) parsed.deepenNot.push(line.slice(11).trim());
  }
  return parsed;
}

/** The full object closure of a set of tips, optionally stopping at shallow boundary commits. */
function objectClosure(repo: Repo, tips: string[], shallowBoundary: Set<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = getObject(repo, oid);
    if (obj === null) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!shallowBoundary.has(oid)) for (const parent of info.parents) stack.push(parent);
    } else if (obj.type === 'tree') {
      for (const entry of treeEntries(repo, oid)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match !== null) stack.push(match[1]!);
    }
  }
  return out;
}

function treeEntries(repo: Repo, treeOid: string): Array<{ oid: string }> {
  const obj = getObject(repo, treeOid);
  if (obj === null || obj.type !== 'tree') return [];
  const entries: Array<{ oid: string }> = [];
  let pos = 0;
  while (pos < obj.data.length) {
    const nul = obj.data.indexOf(0x00, pos);
    entries.push({ oid: obj.data.toString('hex', nul + 1, nul + 21) });
    pos = nul + 21;
  }
  return entries;
}

/** The committer timestamp of a commit, seconds; 0 when unparseable. */
function commitTime(repo: Repo, oid: string): number {
  const obj = getObject(repo, oid);
  if (obj === null || obj.type !== 'commit') return 0;
  const match = /^committer .* (\d+) [+-]\d{4}$/m.exec(obj.data.toString('utf8'));
  return match === null ? 0 : Number.parseInt(match[1]!, 10);
}

interface FetchPlan {
  objects: string[];
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const shallowBoundary = new Set(args.shallow);
  // Resolve want-refs and tag wants to their commits for the distance walk.
  const wantOids = [...args.wants];
  for (const ref of args.wantRefs) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined && !wantOids.includes(oid)) wantOids.push(oid);
  }
  const roots: string[] = [];
  for (const oid of wantOids) {
    const commit = peelToCommit(repo, oid);
    if (commit !== null) roots.push(commit);
  }
  // Commits the client says to exclude (deepen-not): everything reachable from those refs.
  const excluded = new Set<string>();
  for (const ref of args.deepenNot) {
    const oid = repo.refs.get(ref);
    if (oid !== undefined) {
      const commit = peelToCommit(repo, oid);
      if (commit !== null) for (const ancestor of ancestorsOf(repo, commit)) excluded.add(ancestor);
    }
  }
  // Distance walk from the wants, honoring the depth limit and the exclusions.
  const limit = args.deepen !== null && Number.isFinite(args.deepen) ? args.deepen : Number.POSITIVE_INFINITY;
  const delivered = new Set<string>();
  const queue: Array<{ oid: string; distance: number }> = roots.map((oid) => ({ oid, distance: 0 }));
  const seenDistance = new Map<string, number>();
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (seenDistance.has(oid) && seenDistance.get(oid)! <= distance) continue;
    seenDistance.set(oid, distance);
    if (excluded.has(oid)) continue;
    if (distance + 1 > limit) continue;
    const obj = getObject(repo, oid);
    if (obj === null || obj.type !== 'commit') continue;
    delivered.add(oid);
    if (args.deepenSince !== null && commitTime(repo, oid) < args.deepenSince) continue;
    for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, distance: distance + 1 });
  }
  // The boundary: delivered commits with a parent that was not delivered.
  const shallow: string[] = [];
  for (const oid of delivered) {
    const obj = getObject(repo, oid);
    if (obj === null || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    if (parents.some((parent) => !delivered.has(parent) && getObject(repo, parent) !== null)) shallow.push(oid);
  }
  const shallowSet = new Set(shallow);
  const unshallow = args.shallow.filter((oid) => delivered.has(oid) && !shallowSet.has(oid));
  // What the client already holds: the haves' closure, not crossing its shallow boundary.
  const held = objectClosure(repo, args.haves, shallowBoundary);
  // What to send: the delivered commits' own objects plus every want's tag chain, minus the held set.
  const send = new Set<string>();
  for (const oid of delivered) {
    send.add(oid);
    const tree = commitTree(repo, oid);
    if (tree !== null) for (const inner of objectClosure(repo, [tree], new Set())) send.add(inner);
  }
  for (const oid of wantOids) {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = getObject(repo, current);
      if (obj === null || obj.type !== 'tag') break;
      send.add(current);
      const match = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (match === null) break;
      current = match[1]!;
    }
  }
  for (const oid of held) send.delete(oid);
  const acks = args.haves.filter((oid) => {
    const obj = getObject(repo, oid);
    return obj !== null && obj.type === 'commit';
  });
  return { objects: [...send], shallow, unshallow, acks, nak: acks.length === 0 };
}

/** Chunk a pack into side-band-64k band-1 packets. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
    return packets;
  }
  for (let pos = 0; pos < pack.length; pos += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(pos, pos + CHUNK)])));
  }
  return packets;
}

function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.nak) parts.push(pktLine('NAK\n'));
    else {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
      parts.push(pktLine('ready\n'));
    }
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  if (args.wantRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const ref of args.wantRefs) {
      const oid = repo.refs.get(ref);
      if (oid !== undefined) parts.push(pktLine(`${oid} ${ref}\n`));
    }
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(buildPack(repo, plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (plan.nak) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(...sidebandPackets(buildPack(repo, plan.objects)));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface RefCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, next } = parsePkts(body, 0);
  const commands: RefCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul === -1 ? line : line.slice(0, nul);
    const fields = text.split(' ');
    if (fields.length >= 3) commands.push({ oldOid: fields[0]!, newOid: fields[1]!, ref: fields[2]! });
  }
  const rest = body.subarray(next);
  let unpackLine = 'unpack ok\n';
  if (rest.length > 0) {
    try {
      unpackPack(repo, rest);
    } catch {
      unpackLine = 'unpack pack error\n';
    }
  }
  const report: string[] = [unpackLine];
  for (const command of commands) {
    report.push(applyRefCommand(repo, command));
  }
  const inner = Buffer.concat([...report.map((line) => pktLine(line)), PKT_FLUSH]);
  // The client negotiated side-band-64k (it only pushes after an advertisement that offers it), so the
  // report stream rides inside band-1 packets, each carrying whole inner pkt-lines.
  const outer: Buffer[] = [];
  let pos = 0;
  while (pos < inner.length) {
    // Split on inner pkt-line boundaries: inner lines are small, so one packet per line is fine.
    const length = parseInt(inner.toString('ascii', pos, pos + 4), 16);
    const slice = length === 0 ? inner.subarray(pos, pos + 4) : inner.subarray(pos, pos + length);
    if (length === 0) {
      outer.push(PKT_FLUSH);
      pos += 4;
    } else {
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
      pos += length;
    }
  }
  return Buffer.concat(outer);
}

/** Apply one ref update with git's rules; returns its report-status line. */
function applyRefCommand(repo: Repo, command: RefCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    if (current === ZERO_OID) return `ng ${ref} reference not found\n`;
    repo.refs.delete(ref);
    return `ok ${ref}\n`;
  }
  const target = getObject(repo, newOid);
  if (target === null) return `ng ${ref} reference not found\n`;
  if (oldOid === ZERO_OID) {
    if (current !== ZERO_OID) return `ng ${ref} already exists\n`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}\n`;
  }
  if (current !== oldOid) return `ng ${ref} stale info\n`;
  if (ref.startsWith('refs/heads/')) {
    const oldCommit = peelToCommit(repo, oldOid);
    const newCommit = peelToCommit(repo, newOid);
    if (oldCommit === null || newCommit === null) return `ng ${ref} reference not found\n`;
    if (!ancestorsOf(repo, newCommit).has(oldCommit)) return `ng ${ref} non-fast-forward\n`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}\n`;
}

// ---------------------------------------------------------------------------
// HTTP surface (called from app.ts)
// ---------------------------------------------------------------------------

export interface GitReply {
  status: number;
  contentType: string;
  body: Buffer;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function gitInfoRefs(forge: Forge, owner: string, name: string, service: string, protocolV2: boolean): GitReply {
  const repo = forge.repo(owner, name);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  if (service === 'git-upload-pack') {
    return {
      status: 200,
      contentType: 'application/x-git-upload-pack-advertisement',
      body: protocolV2 ? v2Advertisement() : v0Advertisement(repo, service),
    };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, service) };
  }
  return { status: 400, contentType: 'text/plain', body: Buffer.from('unknown service\n') };
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function gitUploadPack(forge: Forge, owner: string, name: string, body: Buffer): GitReply {
  const repo = forge.repo(owner, name);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  try {
    const sections = pktSections(body);
    const first = sections[0] ?? [];
    const commandLine = first.length > 0 ? first[0]!.toString('utf8').replace(/\n$/, '') : '';
    if (commandLine === 'command=ls-refs') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, first.slice(1)) };
    }
    if (commandLine === 'command=fetch') {
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV2(repo, parseFetchArgs(first.slice(1))) };
    }
    // No command line: a protocol v0 request (want lines, flush, have lines, flush).
    const flat = sections.flat();
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchV0(repo, parseFetchArgs(flat)) };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function gitReceivePack(forge: Forge, owner: string, name: string, body: Buffer): GitReply {
  const repo = forge.repo(owner, name);
  if (repo === null) return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
  try {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('bad request\n') };
  }
}
