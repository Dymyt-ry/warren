// The hub's state, kept in SQLite (db.ts). Rooms form a tree; a member
// (human or agent) sees one room and everything below it, or the whole
// instance when their scope is null (owners and admins). Messages @mention
// members by handle; agents are only pushed messages that mention them (or
// @room). Rooms, claims and members are few and read on every request, so
// they are cached in memory and written through; messages, the audit trail,
// sessions and links are read from the database.
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { db, getMeta, setMeta, tx } from "./db.js";
import { newSecret, sha256 } from "./auth.js";
import { injectionFlags, LOOP_LIMIT, redactSecrets, type Safety } from "./safety.js";

export type Adapter = "channel" | "exec" | "inbox" | "a2a" | "dashboard";
export const ADAPTERS: Adapter[] = ["channel", "exec", "inbox", "a2a", "dashboard"];
export type MemberKind = "human" | "agent";
export type Role = "owner" | "admin" | "member";
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

/** Per-room human-in-the-loop rules, set by a person in the room. */
export interface RoomPolicy {
  approveContractChanges: boolean; // an agent's contract_change waits for a person of its own org
}

export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string; // markdown, replaces the shared AGENTS.md / PLAN.md file
  claims: Claim[];
  policy: RoomPolicy;
  createdBy: string | null; // handle of whoever created it; they may delete it
  createdAt: string;
}

/** A room as the API returns it: with its latest messages. */
export type RoomWithMessages = Room & { messages: Message[] };

/** Everything a person may want to trace later: holds, reviews, masked secrets, pauses, policy and membership changes. */
export interface AuditEvent {
  id: string;
  at: string;
  type: "held" | "released" | "rejected" | "redacted" | "paused" | "resumed" | "policy" | "room" | "member";
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
  scopeRoomId: string | null; // sees this room and its descendants; null = every room
  adapter: Adapter; // how the member gets pushed messages
  role: Role | null; // people only
  email: string | null; // people who sign in with a password
  owner: string | null; // agents: the person who added them
  paused: boolean; // stopped by a person: can't post, gets no pushes
  disabled: boolean; // removed: can't sign in, keeps their handle so history stays readable
  createdAt: string;
}

/** A member as other members see it: no email, with presence. */
export type PublicMember = Omit<Member, "email"> & { online: boolean };

export const HISTORY = 200; // messages a room carries in API responses

// Emits "message" (Message), "message_update" (Message whose safety status
// changed), "room" (Room), "room_deleted" ({ id }), "member" (PublicMember),
// "presence" ({ handle, online }) and "audit" (AuditEvent).
export const events = new EventEmitter();
events.setMaxListeners(0);

export const publicMember = ({ email: _e, ...m }: Member): PublicMember => ({ ...m, online: isOnline(m.handle) });

// --- cache -------------------------------------------------------------------

type Row = Record<string, unknown>;
const rooms = new Map<string, Room>();
const members = new Map<string, Member>(); // by handle, disabled included

const toMember = (r: Row): Member => ({
  handle: r.handle as string,
  name: r.name as string,
  kind: r.kind as MemberKind,
  org: r.org as string,
  scopeRoomId: (r.scope_room_id as string | null) ?? null,
  adapter: r.adapter as Adapter,
  role: (r.role as Role | null) ?? null,
  email: (r.email as string | null) ?? null,
  owner: (r.owner_handle as string | null) ?? null,
  paused: !!r.paused,
  disabled: !!r.disabled,
  createdAt: r.created_at as string,
});

function load() {
  rooms.clear();
  members.clear();
  for (const r of db.prepare("SELECT * FROM rooms ORDER BY created_at, rowid").all() as Row[])
    rooms.set(r.id as string, {
      id: r.id as string,
      parentId: (r.parent_id as string | null) ?? null,
      name: r.name as string,
      context: r.context as string,
      policy: { approveContractChanges: !!r.approve_contract_changes },
      claims: [],
      createdBy: (r.created_by as string | null) ?? null,
      createdAt: r.created_at as string,
    });
  for (const c of db.prepare("SELECT * FROM claims ORDER BY at").all() as Row[])
    rooms.get(c.room_id as string)?.claims.push({
      id: c.id as string,
      roomId: c.room_id as string,
      by: c.by_handle as string,
      task: c.task as string,
      files: JSON.parse(c.files as string),
      at: c.at as string,
    });
  for (const m of db.prepare("SELECT * FROM members ORDER BY created_at, rowid").all() as Row[]) members.set(m.handle as string, toMember(m));
}
load();

// --- instance ----------------------------------------------------------------

/** True once the first person (the owner) has been created. */
export const isSetUp = () => [...members.values()].some((m) => m.role === "owner" && !m.disabled);
export const instanceName = () => getMeta("instance_name") ?? "Warren";
export const setInstanceName = (name: string) => setMeta("instance_name", name.trim().slice(0, 80) || "Warren");

// --- rooms -------------------------------------------------------------------

export function createRoom(name: string, parentId: string | null, context = "", createdBy: string | null = null): Room {
  if (typeof name !== "string" || !name.trim()) throw new Error("room name is required");
  if (name.trim().length > 80) throw new Error("room names are at most 80 characters");
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  const room: Room = {
    id: uniqueSlug(name, rooms),
    parentId,
    name: name.trim(),
    context: String(context ?? ""),
    claims: [],
    policy: { approveContractChanges: false },
    createdBy,
    createdAt: new Date().toISOString(),
  };
  db.prepare("INSERT INTO rooms (id, parent_id, name, context, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    room.id,
    parentId,
    room.name,
    room.context,
    createdBy,
    room.createdAt,
  );
  rooms.set(room.id, room);
  events.emit("room", room);
  return room;
}

export function updateContext(m: Member, roomId: string, context: string): Room {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  const room = rooms.get(roomId)!;
  room.context = context;
  db.prepare("UPDATE rooms SET context = ? WHERE id = ?").run(context, roomId);
  events.emit("room", room);
  return room;
}

export function renameRoom(roomId: string, name: string, actor: string): Room {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`no such room ${roomId}`);
  if (typeof name !== "string" || !name.trim()) throw new Error("room name is required");
  if (name.trim().length > 80) throw new Error("room names are at most 80 characters");
  const before = room.name;
  room.name = name.trim();
  db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(room.name, roomId);
  events.emit("room", room);
  audit({ type: "room", roomId, actor, detail: `renamed ${before} to ${room.name}` });
  return room;
}

/** Moves a room (and everything below it) under another parent, or to the top with null. */
export function moveRoom(roomId: string, parentId: string | null, actor: string): Room {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`no such room ${roomId}`);
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  for (let r = parentId ? rooms.get(parentId) : undefined; r; r = r.parentId ? rooms.get(r.parentId) : undefined)
    if (r.id === roomId) throw new Error("a room can't move inside itself");
  room.parentId = parentId;
  db.prepare("UPDATE rooms SET parent_id = ? WHERE id = ?").run(parentId, roomId);
  events.emit("room", room);
  audit({ type: "room", roomId, actor, detail: `moved ${room.name} ${parentId ? `into ${rooms.get(parentId)!.name}` : "to the top"}` });
  return room;
}

/** The room and every room below it. */
export function subtree(roomId: string): Room[] {
  return allRooms().filter((r) => isWithin(r.id, roomId));
}

/**
 * Deletes a room, its subrooms, their messages and claims. Refuses while
 * someone's access is scoped to one of those rooms: deleting it would either
 * lock them out or widen what they see, and a person should decide which.
 */
export function deleteRoom(roomId: string, actor: string): string[] {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`no such room ${roomId}`);
  const gone = subtree(roomId).map((r) => r.id);
  const scoped = allMembers().filter((m) => m.scopeRoomId && gone.includes(m.scopeRoomId));
  if (scoped.length)
    throw new Error(
      `${scoped.map((m) => "@" + m.handle).join(", ")} ${scoped.length === 1 ? "has" : "have"} access through this room; remove them or change their access first`,
    );
  tx(() => {
    db.prepare("DELETE FROM links WHERE scope_room_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
    // Removed members keep their row (and handle); they lose the room. canSee() refuses them anyway.
    db.prepare("UPDATE members SET scope_room_id = NULL WHERE disabled = 1 AND scope_room_id IN (SELECT value FROM json_each(?))").run(JSON.stringify(gone));
    db.prepare("DELETE FROM rooms WHERE id = ?").run(roomId); // cascades to subrooms, messages, claims
  });
  for (const id of gone) rooms.delete(id);
  for (const m of members.values()) if (m.disabled && m.scopeRoomId && gone.includes(m.scopeRoomId)) m.scopeRoomId = null;
  audit({ type: "room", roomId: room.parentId ?? roomId, actor, detail: `deleted ${room.name}${gone.length > 1 ? ` and ${gone.length - 1} rooms inside it` : ""}` });
  for (const id of gone) events.emit("room_deleted", { id, parentId: room.parentId });
  return gone;
}

export function getRoom(id: string): Room | undefined {
  return rooms.get(id);
}

export function allRooms(): Room[] {
  return [...rooms.values()];
}

/** True when `roomId` is `ancestorId` or below it. */
export function isWithin(roomId: string, ancestorId: string): boolean {
  for (let r = rooms.get(roomId); r; r = r.parentId ? rooms.get(r.parentId) : undefined) if (r.id === ancestorId) return true;
  return false;
}

/** True when `roomId` is the member's scope room or one of its descendants (any room for an unscoped member). */
export function canSee(m: Member | PublicMember, roomId: string): boolean {
  if (m.disabled || !rooms.has(roomId)) return false;
  return m.scopeRoomId === null || isWithin(roomId, m.scopeRoomId);
}

export function visibleRooms(m: Member): Room[] {
  return allRooms().filter((r) => canSee(m, r.id));
}

/** A room with its latest messages, as `viewer` may read them. */
export function roomView(viewer: Member | undefined, room: Room, limit = HISTORY): RoomWithMessages {
  return { ...room, messages: recentMessages(room.id, limit).map((x) => viewFor(viewer, x)) };
}

// --- members -----------------------------------------------------------------

/** Who answers for what a member does: the person behind an agent, or the person themselves. */
export const responsible = (m: Member) => (m.kind === "agent" ? (m.owner ?? m.handle) : m.handle);

export const isAdmin = (m: Member | undefined | null) => !!m && !m.disabled && (m.role === "owner" || m.role === "admin");

export function addMember(input: {
  handle?: string;
  name: string;
  kind?: MemberKind;
  org: string;
  scopeRoomId: string | null;
  adapter?: Adapter;
  role?: Role | null;
  email?: string | null;
  passwordHash?: string | null;
  token?: string; // plain bearer token; stored hashed
  owner?: string | null;
}): Member {
  if (typeof input.name !== "string" || !input.name.trim()) throw new Error("name is required");
  if (typeof input.org !== "string" || !input.org.trim()) throw new Error("org is required");
  if (input.scopeRoomId !== null && !rooms.has(input.scopeRoomId)) throw new Error(`unknown room ${input.scopeRoomId}`);
  const kind = input.kind ?? "agent";
  if (kind !== "human" && kind !== "agent") throw new Error('kind must be "human" or "agent"');
  if (kind === "agent" && input.scopeRoomId === null) throw new Error("an agent needs a room");
  if (input.adapter && !ADAPTERS.includes(input.adapter)) throw new Error(`adapter must be one of ${ADAPTERS.join(", ")}`);
  const wanted = slug(input.handle ?? input.name);
  if (BROADCAST.has(wanted)) throw new Error(`"@${wanted}" is reserved`);
  if (input.handle && members.has(wanted)) throw new Error(`handle @${wanted} is taken`);
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw new Error("that email address doesn't look right");
  if (email && [...members.values()].some((m) => m.email === email)) throw new Error("someone already uses that email address");
  const member: Member = {
    handle: input.handle ? wanted : uniqueSlug(wanted, members, BROADCAST),
    name: input.name.trim().slice(0, 80),
    kind,
    org: input.org.trim().slice(0, 80),
    scopeRoomId: input.scopeRoomId,
    adapter: input.adapter ?? (kind === "human" ? "dashboard" : "inbox"),
    role: kind === "human" ? (input.role ?? "member") : null,
    email,
    owner: input.owner ?? null,
    paused: false,
    disabled: false,
    createdAt: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO members (handle, name, kind, org, scope_room_id, adapter, role, email, password_hash, token_hash, owner_handle, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    member.handle,
    member.name,
    member.kind,
    member.org,
    member.scopeRoomId,
    member.adapter,
    member.role,
    member.email,
    input.passwordHash ?? null,
    input.token ? sha256(input.token) : null,
    member.owner,
    member.createdAt,
  );
  members.set(member.handle, member);
  events.emit("member", publicMember(member));
  return member;
}

/** Changes what a member is called, sees or may do. */
export function updateMember(handle: string, patch: Partial<Pick<Member, "name" | "org" | "scopeRoomId" | "role" | "adapter">>): Member {
  const m = members.get(handle);
  if (!m) throw new Error(`no such member @${handle}`);
  const next = { ...m };
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) throw new Error("name is required");
    next.name = patch.name.trim().slice(0, 80);
  }
  if (patch.org !== undefined) {
    if (typeof patch.org !== "string" || !patch.org.trim()) throw new Error("org is required");
    next.org = patch.org.trim().slice(0, 80);
  }
  if (patch.scopeRoomId !== undefined) {
    if (patch.scopeRoomId !== null && !rooms.has(patch.scopeRoomId)) throw new Error(`unknown room ${patch.scopeRoomId}`);
    if (m.kind === "agent" && patch.scopeRoomId === null) throw new Error("an agent needs a room");
    next.scopeRoomId = patch.scopeRoomId;
  }
  if (patch.role !== undefined) {
    if (m.kind !== "human") throw new Error("only people have a role");
    if (!["owner", "admin", "member"].includes(patch.role as string)) throw new Error("role must be owner, admin or member");
    next.role = patch.role;
  }
  if (patch.adapter !== undefined) {
    if (!ADAPTERS.includes(patch.adapter)) throw new Error(`adapter must be one of ${ADAPTERS.join(", ")}`);
    next.adapter = patch.adapter;
  }
  db.prepare("UPDATE members SET name = ?, org = ?, scope_room_id = ?, role = ?, adapter = ? WHERE handle = ?").run(
    next.name,
    next.org,
    next.scopeRoomId,
    next.role,
    next.adapter,
    handle,
  );
  Object.assign(m, next);
  events.emit("member", publicMember(m));
  return m;
}

/** Removes a member: they can't sign in or use their token, and their agents go with them. Their handle stays taken. */
export function disableMember(handle: string, actor: string): Member {
  const m = members.get(handle);
  if (!m) throw new Error(`no such member @${handle}`);
  const agents = m.kind === "human" ? allMembers().filter((a) => a.owner === m.handle) : [];
  tx(() => {
    for (const x of [m, ...agents]) {
      db.prepare("UPDATE members SET disabled = 1, password_hash = NULL, token_hash = NULL WHERE handle = ?").run(x.handle);
      db.prepare("DELETE FROM sessions WHERE handle = ?").run(x.handle);
    }
    db.prepare("DELETE FROM claims WHERE by_handle IN (SELECT value FROM json_each(?))").run(JSON.stringify([m, ...agents].map((x) => x.handle)));
  });
  for (const x of [m, ...agents]) {
    x.disabled = true;
    for (const r of rooms.values()) r.claims = r.claims.filter((c) => c.by !== x.handle);
    events.emit("member", publicMember(x));
    kick(x.handle);
    audit({ type: "member", roomId: x.scopeRoomId ?? "*", actor, target: x.handle, detail: `removed @${x.handle}` });
  }
  return m;
}

/**
 * After a person's company or access changed, their agents follow: they take the
 * person's company, and agents in rooms the person no longer sees are removed.
 */
export function reconcileAgents(handle: string, actor: string) {
  const person = members.get(handle);
  if (!person) return;
  for (const a of allMembers().filter((x) => x.kind === "agent" && x.owner === handle)) {
    if (!canSee(person, a.scopeRoomId!)) disableMember(a.handle, actor);
    else if (a.org !== person.org) updateMember(a.handle, { org: person.org });
  }
}

/** A fresh bearer token for a member; the old one stops working. Returned once, stored hashed. */
export function rotateToken(handle: string): string {
  const token = newSecret("wr");
  db.prepare("UPDATE members SET token_hash = ? WHERE handle = ?").run(sha256(token), handle);
  kick(handle);
  return token;
}

export function byTokenValue(token: string | undefined): Member | undefined {
  if (!token) return undefined;
  const row = db.prepare("SELECT handle FROM members WHERE token_hash = ? AND disabled = 0").get(sha256(token)) as { handle: string } | undefined;
  return row ? members.get(row.handle) : undefined;
}

export function getMember(handle: string): Member | undefined {
  return members.get(String(handle).toLowerCase());
}

export function memberByEmail(email: string): Member | undefined {
  const e = String(email).trim().toLowerCase();
  return [...members.values()].find((m) => m.email === e && !m.disabled);
}

export function passwordHashOf(handle: string): string | null {
  return (db.prepare("SELECT password_hash FROM members WHERE handle = ?").get(handle) as { password_hash: string | null } | undefined)?.password_hash ?? null;
}

export function setPasswordHash(handle: string, hash: string) {
  db.prepare("UPDATE members SET password_hash = ? WHERE handle = ?").run(hash, handle);
}

/** Active members. */
export function allMembers(): Member[] {
  return [...members.values()].filter((m) => !m.disabled);
}

/** True when `a` and `b` can both see at least one room. */
export function sharesRoom(a: Member, b: Member): boolean {
  return visibleRooms(a).some((r) => canSee(b, r.id));
}

/** Members who share at least one room with `m` (including `m`). */
export function contactsOf(m: Member): Member[] {
  const mine = visibleRooms(m);
  return allMembers().filter((other) => other.handle === m.handle || mine.some((r) => canSee(other, r.id)));
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

/** Tells open streams of `handle` to close: their credentials changed. */
function kick(handle: string) {
  events.emit("kick", handle);
}

/** Everyone who can see the room: these are the room's members. */
export function roomMembers(roomId: string): Member[] {
  return allMembers().filter((m) => canSee(m, roomId));
}

// --- sessions ------------------------------------------------------------------

const SESSION_DAYS = 30;

/** Signs a person in: returns the session id for the cookie (stored hashed). */
export function createSession(handle: string): { id: string; expiresAt: Date } {
  const id = newSecret("ws");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("INSERT INTO sessions (id_hash, handle, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    sha256(id),
    handle,
    now.toISOString(),
    expiresAt.toISOString(),
  );
  return { id, expiresAt };
}

export function sessionMember(id: string | undefined): Member | undefined {
  if (!id) return undefined;
  const row = db.prepare("SELECT handle, expires_at FROM sessions WHERE id_hash = ?").get(sha256(id)) as
    | { handle: string; expires_at: string }
    | undefined;
  if (!row || row.expires_at < new Date().toISOString()) return undefined;
  const m = members.get(row.handle);
  return m && !m.disabled ? m : undefined;
}

export function endSession(id: string) {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(sha256(id));
}

/** Signs a person out everywhere, except the session `keep` (theirs, after a password change). */
export function endSessions(handle: string, keep?: string) {
  db.prepare("DELETE FROM sessions WHERE handle = ? AND id_hash != ?").run(handle, keep ? sha256(keep) : "");
}

// --- links: invites and password resets -----------------------------------------

export interface Link {
  id: string;
  purpose: "invite" | "reset";
  email: string | null;
  org: string | null;
  scopeRoomId: string | null;
  role: Role | null;
  handle: string | null; // reset: whose password
  createdBy: string | null;
  createdAt: string;
  expiresAt: string;
}

const toLink = (r: Row): Link => ({
  id: r.id as string,
  purpose: r.purpose as Link["purpose"],
  email: (r.email as string | null) ?? null,
  org: (r.org as string | null) ?? null,
  scopeRoomId: (r.scope_room_id as string | null) ?? null,
  role: (r.role as Role | null) ?? null,
  handle: (r.handle as string | null) ?? null,
  createdBy: (r.created_by as string | null) ?? null,
  createdAt: r.created_at as string,
  expiresAt: r.expires_at as string,
});

/** A one-time link. Returns the code for the URL once; the database keeps only its hash. */
export function createLink(input: Omit<Link, "id" | "createdAt" | "expiresAt">, days: number): { link: Link; code: string } {
  const code = newSecret("wi");
  const now = new Date();
  const link: Link = { ...input, id: randomUUID(), createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + days * 86_400_000).toISOString() };
  if (link.purpose === "reset") db.prepare("DELETE FROM links WHERE purpose = 'reset' AND handle = ? AND used_at IS NULL").run(link.handle);
  db.prepare(
    `INSERT INTO links (id, code_hash, purpose, email, org, scope_room_id, role, handle, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(link.id, sha256(code), link.purpose, link.email, link.org, link.scopeRoomId, link.role, link.handle, link.createdBy, link.createdAt, link.expiresAt);
  return { link, code };
}

/** An unused, unexpired link by its code. */
export function findLink(code: unknown, purpose: Link["purpose"]): Link | undefined {
  if (typeof code !== "string" || !code) return undefined;
  const row = db.prepare("SELECT * FROM links WHERE code_hash = ? AND purpose = ? AND used_at IS NULL AND expires_at > ?").get(
    sha256(code),
    purpose,
    new Date().toISOString(),
  ) as Row | undefined;
  return row ? toLink(row) : undefined;
}

/** Marks a link used; false when it was used, revoked or expired in the meantime. */
export function useLink(id: string, by: string | null): boolean {
  const now = new Date().toISOString();
  return db.prepare("UPDATE links SET used_at = ?, used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(now, by, id, now).changes === 1;
}

export function markLinkUser(id: string, by: string) {
  db.prepare("UPDATE links SET used_by = ? WHERE id = ?").run(by, id);
}

/** Pending invites, newest first; only `createdBy`'s unless omitted. */
export function pendingInvites(createdBy?: string): Link[] {
  const rows = db
    .prepare(
      `SELECT * FROM links WHERE purpose = 'invite' AND used_at IS NULL AND expires_at > ? ${createdBy ? "AND created_by = ?" : ""} ORDER BY created_at DESC`,
    )
    .all(...([new Date().toISOString(), createdBy].filter(Boolean) as string[])) as Row[];
  return rows.map(toLink);
}

export function getLink(id: string): Link | undefined {
  const row = db.prepare("SELECT * FROM links WHERE id = ?").get(id) as Row | undefined;
  return row ? toLink(row) : undefined;
}

export function deleteLink(id: string) {
  db.prepare("DELETE FROM links WHERE id = ?").run(id);
}

// --- messages ------------------------------------------------------------------

// @handle not preceded by a word char (emails) and not followed by "/" or "."+word
// (npm scopes like @anna/pkg, domains). Code spans and blocks are skipped.
const MENTION = /(^|[^\w@.\/-])@([a-z0-9][a-z0-9_-]*)(?![\w\/-]|\.\w)/gi;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const BROADCAST = new Set(["room", "here", "all"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** Handles mentioned in `text` that are members of the room, plus whether @room was used. */
export function parseMentions(text: string, roomId: string): { mentions: string[]; mentionsRoom: boolean } {
  const found = new Set<string>();
  let mentionsRoom = false;
  for (const [, , raw] of text.replace(CODE, " ").matchAll(MENTION)) {
    const handle = raw.toLowerCase();
    if (BROADCAST.has(handle)) mentionsRoom = true;
    else {
      const m = members.get(handle);
      if (m && canSee(m, roomId)) found.add(handle);
    }
  }
  return { mentions: [...found], mentionsRoom };
}

const toMessage = (r: Row): Message => ({
  id: r.id as string,
  roomId: r.room_id as string,
  from: r.from_handle as string,
  fromKind: r.from_kind as MemberKind,
  org: r.org as string,
  kind: r.kind as MessageKind,
  text: r.text as string,
  mentions: JSON.parse(r.mentions as string),
  mentionsRoom: !!r.mentions_room,
  safety: JSON.parse(r.safety as string),
  at: r.at as string,
});

/** The room's last `limit` messages, oldest first. */
export function recentMessages(roomId: string, limit = HISTORY): Message[] {
  limit = Math.max(1, Math.min(Math.floor(limit) || HISTORY, 1000));
  const rows = db.prepare("SELECT * FROM messages WHERE room_id = ? ORDER BY seq DESC LIMIT ?").all(roomId, limit) as Row[];
  return rows.reverse().map(toMessage);
}

export function messageCount(roomId: string): number {
  return (db.prepare("SELECT count(*) AS n FROM messages WHERE room_id = ?").get(roomId) as { n: number }).n;
}

/** Agent messages in a row at the end of the room, since a person last spoke or released a held message. */
function agentStreak(roomId: string): number {
  let n = 0;
  for (const x of recentMessages(roomId, LOOP_LIMIT * 4).reverse()) {
    if (x.fromKind === "human" || x.safety.reviewedBy) break;
    if (x.safety.status !== "rejected") n++;
  }
  return n;
}

export function post(m: Member, roomId: string, kind: MessageKind, text: string): Message {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (m.paused) throw new Error(`@${m.handle} is paused by a person of ${m.org}; ask them to resume you`);
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
  if (text.length > 20_000) throw new Error("messages are at most 20 000 characters");
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
  const room = rooms.get(roomId)!;

  // Safety: mask secrets, flag injection attempts, stop agent ping-pong.
  const clean = redactSecrets(text);
  const flags = injectionFlags(clean.text);
  const crossOrg = roomMembers(roomId).some((x) => x.org !== m.org);
  const loop = m.kind === "agent" && agentStreak(roomId) >= LOOP_LIMIT;
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
  db.prepare(
    `INSERT INTO messages (id, room_id, from_handle, from_kind, org, kind, text, mentions, mentions_room, safety, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(msg.id, roomId, msg.from, msg.fromKind, msg.org, kind, msg.text, JSON.stringify(msg.mentions), msg.mentionsRoom ? 1 : 0, JSON.stringify(msg.safety), msg.at);
  events.emit("message", msg);
  if (clean.redactions.length)
    audit({ type: "redacted", roomId, actor: "hub", target: msg.id, detail: `masked ${clean.redactions.join(", ")} in a message from @${m.handle}` });
  if (held) audit({ type: "held", roomId, actor: "hub", target: msg.id, detail: `held a message from @${m.handle}: ${flags.join(", ")}` });
  return msg;
}

export function getMessage(id: string): Message | undefined {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(String(id)) as Row | undefined;
  return row ? toMessage(row) : undefined;
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
  db.prepare("UPDATE messages SET safety = ? WHERE id = ?").run(JSON.stringify(msg.safety), msg.id);
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

/** True when the message should be pushed to `m`: mentioned by handle or via @room, not their own, not held. */
export function isFor(m: Member, msg: Message): boolean {
  if (m.paused || msg.from === m.handle || !canSee(m, msg.roomId)) return false;
  if (msg.safety.status === "held" || msg.safety.status === "rejected") return false;
  return msg.mentionsRoom || msg.mentions.includes(m.handle);
}

/**
 * Messages the member can see that arrived after `sinceId` (the last 500 when
 * omitted), minus their own. With `mentionsOnly`, just the ones addressed to them.
 */
export function inbox(m: Member, sinceId?: string, mentionsOnly = false): Message[] {
  const visible = JSON.stringify(visibleRooms(m).map((r) => r.id));
  const since = sinceId ? (db.prepare("SELECT seq FROM messages WHERE id = ?").get(sinceId) as { seq: number } | undefined)?.seq : undefined;
  const rows = (
    since === undefined
      ? (db
          .prepare("SELECT * FROM messages WHERE room_id IN (SELECT value FROM json_each(?)) AND from_handle != ? ORDER BY seq DESC LIMIT 500")
          .all(visible, m.handle) as Row[]).reverse()
      : (db
          .prepare("SELECT * FROM messages WHERE room_id IN (SELECT value FROM json_each(?)) AND from_handle != ? AND seq > ? ORDER BY seq LIMIT 500")
          .all(visible, m.handle, since) as Row[])
  ).map(toMessage);
  return rows.filter((x) => !mentionsOnly || isFor(m, x)).map((x) => viewFor(m, x));
}

// --- human in the loop: pause, room policy, audit ----------------------------------

const toAudit = (r: Row): AuditEvent => ({
  id: r.id as string,
  at: r.at as string,
  type: r.type as AuditEvent["type"],
  roomId: r.room_id as string,
  actor: r.actor as string,
  ...(r.target ? { target: r.target as string } : {}),
  detail: r.detail as string,
});

export function audit(e: Omit<AuditEvent, "id" | "at">) {
  const event: AuditEvent = { id: randomUUID(), at: new Date().toISOString(), ...e };
  db.prepare("INSERT INTO audit (id, at, type, room_id, actor, target, detail) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    event.id,
    event.at,
    event.type,
    event.roomId,
    event.actor,
    event.target ?? null,
    event.detail,
  );
  events.emit("audit", event);
}

/** True when `m` may see this audit event: events in rooms they see; instance-wide ones ("*") for admins. */
export function canSeeAudit(m: Member, e: AuditEvent): boolean {
  return e.roomId === "*" ? isAdmin(m) : canSee(m, e.roomId) || (m.scopeRoomId === null && !rooms.has(e.roomId));
}

/** The last 500 audit events the member may see (everything without a member: demo overview and admin token). */
export function auditFor(m: Member | undefined): AuditEvent[] {
  const rows = (db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT 2000").all() as Row[]).reverse().map(toAudit);
  return (m ? rows.filter((e) => canSeeAudit(m, e)) : rows).slice(-500);
}

/** A person stops (or resumes) an agent of their own org: it can't post and gets no pushes. */
export function setPaused(actor: Member, handle: string, paused: boolean): Member {
  const target = getMember(handle);
  if (!target || target.disabled) throw new Error(`no such member @${handle}`);
  if (actor.kind !== "human") throw new Error("only a person can pause an agent");
  if (target.kind !== "agent") throw new Error(`@${handle} is a person, not an agent`);
  if (target.org !== actor.org) throw new Error(`only people of ${target.org} can pause @${handle}`);
  if (!canSee(actor, target.scopeRoomId!)) throw new Error(`no such member @${handle}`);
  target.paused = paused;
  db.prepare("UPDATE members SET paused = ? WHERE handle = ?").run(paused ? 1 : 0, target.handle);
  events.emit("member", publicMember(target));
  audit({
    type: paused ? "paused" : "resumed",
    roomId: target.scopeRoomId!,
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
  db.prepare("UPDATE rooms SET approve_contract_changes = ? WHERE id = ?").run(room.policy.approveContractChanges ? 1 : 0, roomId);
  events.emit("room", room);
  audit({
    type: "policy",
    roomId,
    actor: actor.handle,
    detail: `contract changes from agents ${room.policy.approveContractChanges ? "need approval" : "go out directly"}`,
  });
  return room;
}

// --- claims and file locks ---------------------------------------------------------

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
  db.prepare("INSERT INTO claims (id, room_id, by_handle, task, files, at) VALUES (?, ?, ?, ?, ?, ?)").run(
    created.id,
    roomId,
    m.handle,
    created.task,
    JSON.stringify(files),
    created.at,
  );
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
    db.prepare("DELETE FROM claims WHERE id = ?").run(c.id);
    room.claims.splice(i, 1);
    events.emit("room", room);
    return c;
  }
  throw new Error(`no such claim ${claimId}`);
}

// --- helpers -----------------------------------------------------------------------

export function slug(name: string): string {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 40).replace(/-$/, "") || "room";
}

function uniqueSlug(name: string, taken: Map<string, unknown>, reserved = new Set<string>()): string {
  const base = slug(name);
  let id = base;
  for (let i = 2; taken.has(id) || reserved.has(id); i++) id = `${base}-${i}`;
  return id;
}
