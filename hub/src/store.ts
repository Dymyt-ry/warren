// In-memory state for the hub. Rooms form a tree; a token grants access to
// one room and everything below it. Restarting the hub wipes everything.
import { EventEmitter } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";

export type Adapter = "channel" | "exec" | "inbox" | "a2a";

export interface Message {
  id: string;
  roomId: string;
  from: string; // "agentName@org"
  kind: "note" | "contract_change" | "question" | "done";
  text: string;
  at: string;
}

export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string; // markdown, replaces the shared AGENTS.md / PLAN.md file
  messages: Message[];
}

export interface Token {
  token: string;
  agentName: string;
  org: string;
  scopeRoomId: string; // sees this room and its descendants
  adapter: Adapter;
}

const rooms = new Map<string, Room>();
const tokens = new Map<string, Token>();

// Emits "message" (Message) and "room" (Room) for SSE subscribers.
export const events = new EventEmitter();
events.setMaxListeners(0);

export function createRoom(name: string, parentId: string | null, context = ""): Room {
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  const room: Room = { id: slug(name), parentId, name, context, messages: [] };
  rooms.set(room.id, room);
  events.emit("room", room);
  return room;
}

export function issueToken(
  agentName: string,
  org: string,
  scopeRoomId: string,
  adapter: Adapter,
  token = `wr_${randomBytes(12).toString("hex")}`,
): Token {
  if (!rooms.has(scopeRoomId)) throw new Error(`unknown room ${scopeRoomId}`);
  const t: Token = { token, agentName, org, scopeRoomId, adapter };
  tokens.set(t.token, t);
  return t;
}

export function getToken(token: string | undefined): Token | undefined {
  return token ? tokens.get(token) : undefined;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

/** True when `roomId` is the token's scope room or one of its descendants. */
export function canSee(t: Token, roomId: string): boolean {
  for (let r = rooms.get(roomId); r; r = r.parentId ? rooms.get(r.parentId) : undefined) {
    if (r.id === t.scopeRoomId) return true;
  }
  return false;
}

export function visibleRooms(t: Token): Room[] {
  return allRooms().filter((r) => canSee(t, r.id));
}

export function post(t: Token, roomId: string, kind: Message["kind"], text: string): Message {
  if (!canSee(t, roomId)) throw new Error(`no access to room ${roomId}`);
  const room = rooms.get(roomId)!;
  const msg: Message = {
    id: randomUUID(),
    roomId,
    from: `${t.agentName}@${t.org}`,
    kind,
    text,
    at: new Date().toISOString(),
  };
  room.messages.push(msg);
  events.emit("message", msg);
  return msg;
}

/** Messages the token can see that arrived after `sinceId` (all when omitted). */
export function inbox(t: Token, sinceId?: string): Message[] {
  const all = visibleRooms(t)
    .flatMap((r) => r.messages)
    .sort((a, b) => a.at.localeCompare(b.at));
  const idx = sinceId ? all.findIndex((m) => m.id === sinceId) : -1;
  return all.slice(idx + 1).filter((m) => m.from !== `${t.agentName}@${t.org}`);
}

function slug(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "") || "room";
  let id = base;
  for (let i = 2; rooms.has(id); i++) id = `${base}-${i}`;
  return id;
}
