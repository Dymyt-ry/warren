// In-memory state for the hub. Rooms form a tree; a member (human or agent)
// holds a token that grants one room and everything below it. Messages
// @mention members by handle; agents are only pushed messages that mention
// them (or @room). Restarting the hub wipes everything.
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

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
  at: string;
}

export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string; // markdown, replaces the shared AGENTS.md / PLAN.md file
  messages: Message[];
}

export interface Member {
  handle: string; // unique, lowercase: "anna", "claude-anna"
  name: string; // display name
  kind: MemberKind;
  org: string;
  scopeRoomId: string; // sees this room and its descendants
  adapter: Adapter; // how the member gets pushed messages
  token: string;
}

/** A member as other members see it: without the token, with presence. */
export type PublicMember = Omit<Member, "token"> & { online: boolean };

const rooms = new Map<string, Room>();
const members = new Map<string, Member>(); // by handle
const byToken = new Map<string, Member>();

// Emits "message" (Message), "room" (Room), "member" (PublicMember) and
// "presence" ({ handle, online }).
export const events = new EventEmitter();
events.setMaxListeners(0);

export const publicMember = ({ token: _t, ...m }: Member): PublicMember => ({ ...m, online: isOnline(m.handle) });

// --- rooms -----------------------------------------------------------------

export function createRoom(name: string, parentId: string | null, context = ""): Room {
  if (!name?.trim()) throw new Error("room name is required");
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  const room: Room = { id: uniqueSlug(name, rooms), parentId, name: name.trim(), context, messages: [] };
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
  if (wanted === "room") throw new Error(`"@room" is reserved`);
  if (input.handle && members.has(wanted)) throw new Error(`handle @${wanted} is taken`);
  const member: Member = {
    handle: input.handle ? wanted : uniqueSlug(wanted, members),
    name: input.name.trim(),
    kind,
    org: input.org.trim(),
    scopeRoomId: input.scopeRoomId,
    adapter: input.adapter ?? (kind === "human" ? "dashboard" : "inbox"),
    token: input.token ?? `wr_${randomBytes(12).toString("hex")}`,
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

const MENTION = /(^|[^\w@.-])@([a-z0-9][a-z0-9_-]*)/gi;

/** Handles mentioned in `text` that are members of the room, plus whether @room was used. */
export function parseMentions(text: string, roomId: string): { mentions: string[]; mentionsRoom: boolean } {
  const found = new Set<string>();
  let mentionsRoom = false;
  for (const [, , raw] of text.matchAll(MENTION)) {
    const handle = raw.toLowerCase();
    if (handle === "room" || handle === "here" || handle === "all") mentionsRoom = true;
    else if (members.has(handle) && canSee(members.get(handle)!, roomId)) found.add(handle);
  }
  return { mentions: [...found], mentionsRoom };
}

export function post(m: Member, roomId: string, kind: MessageKind, text: string): Message {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (!text?.trim()) throw new Error("text is required");
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
  const room = rooms.get(roomId)!;
  const msg: Message = {
    id: randomUUID(),
    roomId,
    from: m.handle,
    fromKind: m.kind,
    org: m.org,
    kind,
    text,
    ...parseMentions(text, roomId),
    at: new Date().toISOString(),
  };
  room.messages.push(msg);
  events.emit("message", msg);
  return msg;
}

/** True when the message should be pushed to `m`: mentioned by handle or via @room, and not their own. */
export function isFor(m: Member, msg: Message): boolean {
  if (msg.from === m.handle || !canSee(m, msg.roomId)) return false;
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
    .filter((x) => x.from !== m.handle && (!mentionsOnly || isFor(m, x)));
}

// --- helpers ---------------------------------------------------------------

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
}

function uniqueSlug(name: string, taken: Map<string, unknown>): string {
  const base = slug(name);
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}
