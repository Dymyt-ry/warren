// In-memory state for the hub. Rooms form a tree; a member (human or agent)
// holds a token that grants one room and everything below it. Messages
// @mention members by handle; agents are only pushed messages that mention
// them (or @room). Restarting the hub wipes everything.
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { injectionFlags, LOOP_LIMIT, redactSecrets, type Safety } from "./safety.js";

export type Adapter = "channel" | "exec" | "inbox" | "a2a" | "dashboard";
export type MemberKind = "human" | "agent";
export const MESSAGE_KINDS = ["note", "contract_change", "question", "done"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface Message {
  id: string;
  roomId: string;
  from: string; // sender handle, e.g. "codex-ben"
  fromKind: MemberKind;
  org: string;
  kind: MessageKind;
  text: string;
  mentions: string[]; // handles that get this pushed; "@room" expands to everyone in the room
  mentionsRoom: boolean;
  safety: Safety;
  at: string;
}

/** "I'm on this": a task, optionally with the files the holder is about to change. */
export interface Claim {
  id: string;
  roomId: string;
  by: string; // handle
  task: string;
  files: string[]; // paths or globs; "src/api/*" and "src/api/**" lock everything under src/api/
  at: string;
}

export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string; // markdown, replaces the shared AGENTS.md / PLAN.md file
  messages: Message[];
  claims: Claim[];
  policy: RoomPolicy;
}

/** Per-room human-in-the-loop rules, set by a person in the room. */
export interface RoomPolicy {
  approveContractChanges: boolean; // an agent's contract_change waits for a person of its own org
}

/** Everything a person may want to trace later: holds, reviews, masked secrets, pauses, policy changes. */
export interface AuditEvent {
  id: string;
  at: string;
  type: "held" | "released" | "rejected" | "redacted" | "paused" | "resumed" | "policy";
  roomId: string;
  actor: string; // handle, or "hub" for automatic actions
  target?: string; // message id or member handle
  detail: string;
}

export interface Member {
  handle: string; // unique, lowercase: "anna", "claude-anna"
  name: string; // display name
  kind: MemberKind;
  org: string;
  scopeRoomId: string; // sees this room and its descendants
  adapter: Adapter; // how the member gets pushed messages
  token: string;
  paused: boolean; // stopped by a person: can't post, gets no pushes
}

/** A member as other members see it: without the token, with presence. */
export type PublicMember = Omit<Member, "token"> & { online: boolean };

const rooms = new Map<string, Room>();
const members = new Map<string, Member>(); // by handle
const byToken = new Map<string, Member>();

// Emits "message" (Message), "message_update" (Message whose safety status
// changed), "room" (Room), "member" (PublicMember) and "presence" ({ handle, online }).
export const events = new EventEmitter();
events.setMaxListeners(0);

export const publicMember = ({ token: _t, ...m }: Member): PublicMember => ({ ...m, online: isOnline(m.handle) });

// --- rooms -----------------------------------------------------------------

export function createRoom(name: string, parentId: string | null, context = ""): Room {
  if (!name?.trim()) throw new Error("room name is required");
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  const room: Room = { id: uniqueSlug(name, rooms), parentId, name: name.trim(), context, messages: [], claims: [], policy: { approveContractChanges: false } };
  rooms.set(room.id, room);
  events.emit("room", room);
  return room;
}

export function updateContext(m: Member, roomId: string, context: string): Room {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  const room = rooms.get(roomId)!;
  room.context = context;
  events.emit("room", room);
  return room;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

/** True when `roomId` is the member's scope room or one of its descendants. */
export function canSee(m: Member | PublicMember, roomId: string): boolean {
  for (let r = rooms.get(roomId); r; r = r.parentId ? rooms.get(r.parentId) : undefined) {
    if (r.id === m.scopeRoomId) return true;
  }
  return false;
}

export function visibleRooms(m: Member): Room[] {
  return allRooms().filter((r) => canSee(m, r.id));
}

// --- members ---------------------------------------------------------------

export function addMember(input: {
  handle?: string;
  name: string;
  kind?: MemberKind;
  org: string;
  scopeRoomId: string;
  adapter?: Adapter;
  token?: string;
}): Member {
  if (!input.name?.trim()) throw new Error("name is required");
  if (!input.org?.trim()) throw new Error("org is required");
  if (!rooms.has(input.scopeRoomId)) throw new Error(`unknown room ${input.scopeRoomId}`);
  const kind = input.kind ?? "agent";
  const wanted = slug(input.handle ?? input.name);
  if (BROADCAST.has(wanted)) throw new Error(`"@${wanted}" is reserved`);
  if (input.handle && members.has(wanted)) throw new Error(`handle @${wanted} is taken`);
  const member: Member = {
    handle: input.handle ? wanted : uniqueSlug(wanted, members, BROADCAST),
    name: input.name.trim(),
    kind,
    org: input.org.trim(),
    scopeRoomId: input.scopeRoomId,
    adapter: input.adapter ?? (kind === "human" ? "dashboard" : "inbox"),
    token: input.token ?? `wr_${randomBytes(12).toString("hex")}`,
    paused: false,
  };
  members.set(member.handle, member);
  byToken.set(member.token, member);
  events.emit("member", publicMember(member));
  return member;
}

export function byTokenValue(token: string | undefined): Member | undefined {
  return token ? byToken.get(token) : undefined;
}

export function getMember(handle: string): Member | undefined {
  return members.get(handle.toLowerCase());
}

export function allMembers(): Member[] {
  return [...members.values()];
}

/** True when `a` and `b` can both see at least one room. */
export function sharesRoom(a: Member, b: Member): boolean {
  return visibleRooms(a).some((r) => canSee(b, r.id));
}

/** Members who share at least one room with `m` (including `m`). */
export function contactsOf(m: Member): Member[] {
  const mine = visibleRooms(m);
  return allMembers().filter((other) => mine.some((r) => canSee(other, r.id)));
}

// Presence: a member is online while they hold an SSE connection (bridge or dashboard).
const connections = new Map<string, number>();

export function isOnline(handle: string): boolean {
  return (connections.get(handle) ?? 0) > 0;
}

/** Call on SSE connect (+1) and disconnect (-1); emits "presence" when online flips. */
export function trackConnection(m: Member, delta: 1 | -1) {
  const before = connections.get(m.handle) ?? 0;
  const after = Math.max(0, before + delta);
  connections.set(m.handle, after);
  if ((before > 0) !== (after > 0)) events.emit("presence", { handle: m.handle, online: after > 0 });
}

/** Everyone who can see the room: these are the room's members. */
export function roomMembers(roomId: string): Member[] {
  return allMembers().filter((m) => canSee(m, roomId));
}

// --- messages --------------------------------------------------------------

// @handle not preceded by a word char (emails) and not followed by "/" or "."+word
// (npm scopes like @anna/pkg, domains). Code spans and blocks are skipped.
const MENTION = /(^|[^\w@.\/-])@([a-z0-9][a-z0-9_-]*)(?![\w\/-]|\.\w)/gi;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const BROADCAST = new Set(["room", "here", "all"]);

/** Handles mentioned in `text` that are members of the room, plus whether @room was used. */
export function parseMentions(text: string, roomId: string): { mentions: string[]; mentionsRoom: boolean } {
  const found = new Set<string>();
  let mentionsRoom = false;
  for (const [, , raw] of text.replace(CODE, " ").matchAll(MENTION)) {
    const handle = raw.toLowerCase();
    if (BROADCAST.has(handle)) mentionsRoom = true;
    else if (members.has(handle) && canSee(members.get(handle)!, roomId)) found.add(handle);
  }
  return { mentions: [...found], mentionsRoom };
}

/** Agent messages in a row at the end of the room, since a person last spoke or released a held message. */
function agentStreak(room: Room): number {
  let n = 0;
  for (let i = room.messages.length - 1; i >= 0; i--) {
    const x = room.messages[i];
    if (x.fromKind === "human" || x.safety.reviewedBy) break;
    if (x.safety.status !== "rejected") n++;
  }
  return n;
}

export function post(m: Member, roomId: string, kind: MessageKind, text: string): Message {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (m.paused) throw new Error(`@${m.handle} is paused by a person of ${m.org}; ask them to resume you`);
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
  const room = rooms.get(roomId)!;

  // Safety: mask secrets, flag injection attempts, stop agent ping-pong.
  const clean = redactSecrets(text);
  const flags = injectionFlags(clean.text);
  const crossOrg = roomMembers(roomId).some((x) => x.org !== m.org);
  const loop = m.kind === "agent" && agentStreak(room) >= LOOP_LIMIT;
  if (loop) flags.push("agent-loop");
  const needsApproval = room.policy.approveContractChanges && kind === "contract_change" && m.kind === "agent";
  if (needsApproval) flags.push("needs-approval");
  const held = loop || needsApproval || (flags.length > 0 && crossOrg);

  const msg: Message = {
    id: randomUUID(),
    roomId,
    from: m.handle,
    fromKind: m.kind,
    org: m.org,
    kind,
    text: clean.text,
    ...parseMentions(clean.text, roomId),
    safety: { status: held ? "held" : "delivered", flags, redactions: clean.redactions },
    at: new Date().toISOString(),
  };
  room.messages.push(msg);
  events.emit("message", msg);
  if (clean.redactions.length)
    audit({ type: "redacted", roomId, actor: "hub", target: msg.id, detail: `masked ${clean.redactions.join(", ")} in a message from @${m.handle}` });
  if (held) audit({ type: "held", roomId, actor: "hub", target: msg.id, detail: `held a message from @${m.handle}: ${flags.join(", ")}` });
  return msg;
}

export function getMessage(id: string): Message | undefined {
  for (const r of rooms.values()) {
    const msg = r.messages.find((x) => x.id === id);
    if (msg) return msg;
  }
}

/**
 * A person releases or rejects a held message. Released messages are pushed
 * to the agents they mention as if they had just been posted.
 */
export function review(m: Member, messageId: string, decision: "release" | "reject"): Message {
  const msg = getMessage(messageId);
  if (!msg || !canSee(m, msg.roomId)) throw new Error(`no such message ${messageId}`);
  if (m.kind !== "human") throw new Error("only a person can review held messages");
  if (msg.from === m.handle) throw new Error("you can't review your own message");
  if (msg.safety.status !== "held") throw new Error(`message is ${msg.safety.status}, not held`);
  // A contract change is approved by the people who own the agent that proposed it.
  if (msg.safety.flags.includes("needs-approval") && m.org !== msg.org)
    throw new Error(`only a person of ${msg.org} can approve @${msg.from}'s contract change`);
  // A suspected injection is released by the people it targets, not by the company that sent it
  // (unless no person of another company can see the room).
  const suspicious = msg.safety.flags.some((f) => f !== "needs-approval" && f !== "agent-loop");
  const otherOrgPerson = roomMembers(msg.roomId).some((x) => x.kind === "human" && x.org !== msg.org);
  if (suspicious && m.org === msg.org && otherOrgPerson)
    throw new Error(`a person outside ${msg.org} reviews this: it was flagged as a possible attack from ${msg.org}`);
  msg.safety = { ...msg.safety, status: decision === "release" ? "released" : "rejected", reviewedBy: m.handle };
  events.emit("message_update", msg);
  audit({
    type: decision === "release" ? "released" : "rejected",
    roomId: msg.roomId,
    actor: m.handle,
    target: msg.id,
    detail: `${decision === "release" ? "released" : "rejected"} @${msg.from}'s held message (${msg.safety.flags.join(", ")})`,
  });
  if (decision === "release") events.emit("message", msg); // now reaches the agents' streams
  return msg;
}

/** What `viewer` may read of a message: agents don't see the text of held or rejected messages from others. */
export function viewFor(viewer: Member | undefined, msg: Message): Message {
  const hidden = msg.safety.status === "held" || msg.safety.status === "rejected";
  if (!hidden || !viewer || viewer.kind !== "agent" || viewer.handle === msg.from) return msg;
  const note = msg.safety.status === "held" ? "[held for human review]" : `[rejected by @${msg.safety.reviewedBy}]`;
  return { ...msg, text: note, mentions: [], mentionsRoom: false };
}

export function roomView(viewer: Member | undefined, room: Room): Room {
  return viewer?.kind === "agent" ? { ...room, messages: room.messages.map((x) => viewFor(viewer, x)) } : room;
}

/** True when the message should be pushed to `m`: mentioned by handle or via @room, not their own, not held. */
export function isFor(m: Member, msg: Message): boolean {
  if (m.paused || msg.from === m.handle || !canSee(m, msg.roomId)) return false;
  if (msg.safety.status === "held" || msg.safety.status === "rejected") return false;
  return msg.mentionsRoom || msg.mentions.includes(m.handle);
}

/**
 * Messages the member can see that arrived after `sinceId` (all when omitted),
 * minus their own. With `mentionsOnly`, just the ones addressed to them.
 */
export function inbox(m: Member, sinceId?: string, mentionsOnly = false): Message[] {
  const all = visibleRooms(m)
    .flatMap((r) => r.messages)
    .sort((a, b) => a.at.localeCompare(b.at));
  const idx = sinceId ? all.findIndex((x) => x.id === sinceId) : -1;
  return all
    .slice(idx + 1)
    .filter((x) => x.from !== m.handle && (!mentionsOnly || isFor(m, x)))
    .map((x) => viewFor(m, x));
}

// --- human in the loop: pause, room policy, audit ------------------------------

const auditLog: AuditEvent[] = [];

function audit(e: Omit<AuditEvent, "id" | "at">) {
  const event: AuditEvent = { id: randomUUID(), at: new Date().toISOString(), ...e };
  auditLog.push(event);
  events.emit("audit", event);
}

/** Audit events in rooms the member can see (everything without a member: demo overview). */
export function auditFor(m: Member | undefined): AuditEvent[] {
  return m ? auditLog.filter((e) => canSee(m, e.roomId)) : [...auditLog];
}

/** A person stops (or resumes) an agent of their own org: it can't post and gets no pushes. */
export function setPaused(actor: Member, handle: string, paused: boolean): Member {
  const target = getMember(handle);
  if (!target) throw new Error(`no such member @${handle}`);
  if (actor.kind !== "human") throw new Error("only a person can pause an agent");
  if (target.kind !== "agent") throw new Error(`@${handle} is a person, not an agent`);
  if (target.org !== actor.org) throw new Error(`only people of ${target.org} can pause @${handle}`);
  target.paused = paused;
  events.emit("member", publicMember(target));
  audit({
    type: paused ? "paused" : "resumed",
    roomId: target.scopeRoomId,
    actor: actor.handle,
    target: target.handle,
    detail: `${paused ? "paused" : "resumed"} @${target.handle}`,
  });
  return target;
}

export function setPolicy(actor: Member, roomId: string, policy: Partial<RoomPolicy>): Room {
  if (!canSee(actor, roomId)) throw new Error(`no access to room ${roomId}`);
  if (actor.kind !== "human") throw new Error("only a person can change a room's policy");
  const room = rooms.get(roomId)!;
  if (typeof policy.approveContractChanges === "boolean") room.policy.approveContractChanges = policy.approveContractChanges;
  events.emit("room", room);
  audit({
    type: "policy",
    roomId,
    actor: actor.handle,
    detail: `contract changes from agents ${room.policy.approveContractChanges ? "need approval" : "go out directly"}`,
  });
  return room;
}

// --- claims and file locks ---------------------------------------------------

/** Directory prefix a path or glob covers: "src/api/**" -> "src/api/", "src/a.ts" -> "src/a.ts". */
function lockPrefix(pattern: string): string {
  const p = pattern.trim().replace(/^\.\//, "");
  const star = p.search(/[*?[{]/);
  return star === -1 ? p : p.slice(0, star);
}

function overlaps(a: string, b: string): boolean {
  const pa = lockPrefix(a);
  const pb = lockPrefix(b);
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/** Locks held by others that overlap `files`, across every room: the repo is shared even when rooms aren't. */
export function lockConflicts(m: Member, files: string[]): { claim: Claim; file: string; held: string }[] {
  const out: { claim: Claim; file: string; held: string }[] = [];
  for (const r of rooms.values())
    for (const c of r.claims)
      if (c.by !== m.handle)
        for (const file of files) for (const held of c.files) if (overlaps(file, held)) out.push({ claim: c, file, held });
  return out;
}

/**
 * Claim a task in a room, optionally locking files. Refuses when another member
 * holds an overlapping lock. The holder is named only if the caller can see
 * that room; otherwise the conflict is reported without details.
 */
export function claim(m: Member, roomId: string, task: string, files: string[] = []): Claim {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (typeof task !== "string" || !task.trim()) throw new Error("task is required");
  if (!Array.isArray(files) || files.some((f) => typeof f !== "string" || !f.trim())) throw new Error("files must be paths");
  const conflicts = lockConflicts(m, files);
  if (conflicts.length) {
    const c = conflicts[0];
    const who = canSee(m, c.claim.roomId) ? `@${c.claim.by} (room ${c.claim.roomId}: "${c.claim.task}")` : "a member of another room";
    throw new Error(`${c.file} is locked by ${who} via ${c.held}`);
  }
  const room = rooms.get(roomId)!;
  const created: Claim = { id: randomUUID(), roomId, by: m.handle, task: task.trim(), files, at: new Date().toISOString() };
  room.claims.push(created);
  events.emit("room", room);
  return created;
}

/** Release your own claim (or any claim in a room you see, when `force`: a person unblocking a stuck agent). */
export function release(m: Member, claimId: string, force = false): Claim {
  for (const room of rooms.values()) {
    const i = room.claims.findIndex((c) => c.id === claimId);
    if (i === -1) continue;
    const c = room.claims[i];
    if (!canSee(m, room.id)) break;
    if (c.by !== m.handle && !(force && m.kind === "human")) throw new Error(`claim is held by @${c.by}; only a person can force-release it`);
    room.claims.splice(i, 1);
    events.emit("room", room);
    return c;
  }
  throw new Error(`no such claim ${claimId}`);
}

// --- helpers ---------------------------------------------------------------

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}

function uniqueSlug(name: string, taken: Map<string, unknown>, reserved = new Set<string>()): string {
  const base = slug(name);
  let id = base;
  for (let i = 2; taken.has(id) || reserved.has(id); i++) id = `${base}-${i}`;
  return id;
}
