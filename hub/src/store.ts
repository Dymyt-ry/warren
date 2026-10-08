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
import { hashPassword, newSecret, sha256, verifyPassword } from "./auth.js";
import { gateDecision, injectionFlags, isAttackFlag, LOOP_LIMIT, redactSecrets, settle, type Approval, type Decision, type Safety } from "./safety.js";

export type Adapter = "channel" | "exec" | "inbox" | "a2a" | "dashboard";
export const ADAPTERS: Adapter[] = ["channel", "exec", "inbox", "a2a", "dashboard"];
export type MemberKind = "human" | "agent";
export type Role = "owner" | "admin" | "member";
export const MESSAGE_KINDS = ["note", "contract_change", "question", "done"] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

export interface MessageTarget {
  agent: string;
  sessionName?: string;
}

export interface MessageMetadata {
  from: {
    agent: string;
    sessionId?: string;
    sessionName?: string;
    /** Immutable label kept even if the slot is later renamed or rebound. */
    sessionNameSnapshot?: string;
  };
  to: MessageTarget[];
}

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
  metadata: MessageMetadata;
  safety: Safety;
  at: string;
  delivered?: string[]; // for people: agents that got it pushed or read it from their inbox
}

export interface AgentSession {
  id: string;
  handle: string;
  name: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

export interface PublicAgentSession {
  name: string;
  online: boolean;
  lastSeenAt: string;
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
  prefs: Prefs; // people: their own settings
  twoFactor: boolean; // people: signs in with a one-time code too
  createdAt: string;
}

export type Language = "en" | "cs";
export type Theme = "system" | "light" | "dark";

export interface Prefs {
  language: Language;
  theme: Theme;
  holdAllForeign: boolean; // hold every message from another company to my agents, not only suspicious ones
  emailOnHold: boolean; // email me when a message to my agents waits for me
}

export const DEFAULT_PREFS: Prefs = { language: "en", theme: "system", holdAllForeign: false, emailOnHold: true };

/** A member as other members see it: no email or settings, with presence. */
export type PublicMember = Omit<Member, "email" | "prefs"> & { online: boolean; sessions?: PublicAgentSession[] };

export const HISTORY = 200; // messages a room carries in API responses

// Emits "message" (Message), "message_update" (Message whose safety status
// changed), "room" (Room), "room_deleted" ({ id }), "member" (PublicMember),
// "presence" ({ handle, online }) and "audit" (AuditEvent).
export const events = new EventEmitter();
events.setMaxListeners(0);

export const publicMember = ({ email: _e, prefs: _p, ...m }: Member): PublicMember => ({
  ...m,
  online: isOnline(m.handle),
  ...(m.kind === "agent" ? { sessions: publicAgentSessions(m.handle) } : {}),
});

function parsePrefs(raw: unknown): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(String(raw ?? "{}")) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

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
  prefs: parsePrefs(r.prefs),
  twoFactor: !!r.totp_secret,
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
repairUnsafeSharedState();

// --- instance ----------------------------------------------------------------

/** True once the first person (the owner) has been created. */
export const isSetUp = () => [...members.values()].some((m) => m.role === "owner" && !m.disabled);
export const instanceName = () => getMeta("instance_name") ?? "Warren";
export const setInstanceName = (name: string) => setMeta("instance_name", name.trim().slice(0, 80) || "Warren");

// --- rooms -------------------------------------------------------------------

/**
 * Creates a room. Its id is the name as a slug plus a random suffix ("basket-migration-4f2a"):
 * a plain slug would collide with rooms other people can't see and tell them those rooms
 * exist. `exactId` keeps the plain slug, for the first room and the demo.
 */
export function createRoom(name: string, parentId: string | null, context = "", createdBy: string | null = null, exactId = false): Room {
  if (typeof name !== "string" || !name.trim()) throw new Error("room name is required");
  if (name.trim().length > 80) throw new Error("room names are at most 80 characters");
  if (parentId && !rooms.has(parentId)) throw new Error(`unknown parent room ${parentId}`);
  const creator = createdBy ? (members.get(createdBy) ?? null) : null;
  name = guardShared(creator, parentId, name, "room name");
  context = guardShared(creator, parentId, String(context ?? ""), "room context");
  const room: Room = {
    id: exactId ? uniqueSlug(name, rooms) : randomSlug(name),
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

/**
 * Text that every agent in a room reads but nobody posts as a message (room
 * context, room names, claim tasks) goes through the same guards: secrets are
 * masked, and in a room shared with another company, text that looks like an
 * attack is refused (post it as a message instead: messages can be held and
 * reviewed, context can't). Returns the masked text.
 */
function guardShared(m: Member | null, roomId: string | null, text: string, what: string): string {
  const clean = redactSecrets(text);
  const flags = injectionFlags(clean.text);
  if (flags.length && m && roomId && roomMembers(roomId).some((x) => x.org !== m.org))
    throw new Error(
      `this ${what} ${flags.join(", ")}: in a room shared with another company that is refused, because every agent here reads it as instructions. Post it as a message instead, where a person can review it`,
    );
  if (clean.redactions.length && roomId)
    audit({ type: "redacted", roomId, actor: "hub", detail: `masked ${clean.redactions.join(", ")} in a ${what} from @${m?.handle ?? "admin"}` });
  return clean.text;
}

/**
 * A topology or membership change can turn formerly private instructions into
 * cross-company instructions. Validate every shared room against the same
 * injection rules before committing such a change.
 */
function assertSharedStateSafe() {
  for (const room of rooms.values()) {
    if (new Set(roomMembers(room.id).map((m) => m.org)).size < 2) continue;
    for (const [what, text] of [
      ["room name", room.name],
      ["room context", room.context],
      ...room.claims.map((c) => ["claim", c.task]),
    ] as [string, string][]) {
      const flags = injectionFlags(text);
      if (flags.length)
        throw new Error(
          `moving or sharing this room would expose a ${what} that ${flags.join(", ")} to another company; edit it while the room is private, or post it as a reviewable message`,
        );
    }
  }
}

/** Quarantine unsafe shared metadata left by versions that lacked exposure checks. */
function repairUnsafeSharedState() {
  const fixes: { roomId: string; kind: "name" | "context" | "claim"; id?: string; value: string; reasons: string[] }[] = [];
  for (const room of rooms.values()) {
    if (new Set(roomMembers(room.id).map((m) => m.org)).size < 2) continue;
    const inspect = (kind: "name" | "context" | "claim", value: string, id?: string) => {
      const clean = redactSecrets(value);
      const flags = injectionFlags(clean.text);
      if (!flags.length && !clean.redactions.length) return;
      const safe =
        flags.length > 0
          ? kind === "name"
            ? "Review required"
            : "[removed during security upgrade: unsafe cross-company instructions require a person to rewrite this text]"
          : clean.text;
      fixes.push({ roomId: room.id, kind, id, value: safe, reasons: [...flags, ...clean.redactions] });
    };
    inspect("name", room.name);
    inspect("context", room.context);
    for (const claim of room.claims) inspect("claim", claim.task, claim.id);
  }
  if (!fixes.length) return;
  tx(() => {
    for (const fix of fixes) {
      const room = rooms.get(fix.roomId)!;
      if (fix.kind === "name") {
        room.name = fix.value;
        db.prepare("UPDATE rooms SET name = ? WHERE id = ?").run(fix.value, fix.roomId);
      } else if (fix.kind === "context") {
        room.context = fix.value;
        db.prepare("UPDATE rooms SET context = ? WHERE id = ?").run(fix.value, fix.roomId);
      } else {
        const claim = room.claims.find((c) => c.id === fix.id);
        if (claim) claim.task = fix.value;
        db.prepare("UPDATE claims SET task = ? WHERE id = ?").run(fix.value, fix.id!);
      }
      audit({
        type: "redacted",
        roomId: fix.roomId,
        actor: "hub",
        detail: `quarantined unsafe legacy ${fix.kind} during upgrade (${[...new Set(fix.reasons)].join(", ")})`,
      });
    }
  });
}

export function updateContext(m: Member, roomId: string, context: string): Room {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (typeof context !== "string") throw new Error("context must be text");
  if (context.length > 50_000) throw new Error("room context is at most 50 000 characters");
  const room = rooms.get(roomId)!;
  const clean = guardShared(m, roomId, context, "room context");
  room.context = clean;
  db.prepare("UPDATE rooms SET context = ? WHERE id = ?").run(clean, roomId);
  events.emit("room", room);
  // Context is what agents trust most, so every change is on the record.
  audit({ type: "room", roomId, actor: m.handle, detail: `@${m.handle} (${m.org}) changed the context of ${room.name}` });
  return room;
}

export function renameRoom(roomId: string, name: string, actor: string): Room {
  const room = rooms.get(roomId);
  if (!room) throw new Error(`no such room ${roomId}`);
  if (typeof name !== "string" || !name.trim()) throw new Error("room name is required");
  if (name.trim().length > 80) throw new Error("room names are at most 80 characters");
  const before = room.name;
  const by = members.get(actor) ?? null;
  room.name = guardShared(by, roomId, name.trim(), "room name").trim();
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
  // Remember the people who can see the room before changing the topology.
  // After the move, canSee() may already say "no", so a normal room event
  // cannot tell their open dashboard to remove the stale subtree.
  const beforeViewers = allMembers()
    .filter((m) => m.kind === "human" && !m.disabled && canSee(m, roomId))
    .map((m) => m.handle);
  for (let r = parentId ? rooms.get(parentId) : undefined; r; r = r.parentId ? rooms.get(r.parentId) : undefined)
    if (r.id === roomId) throw new Error("a room can't move inside itself");
  const before = room.parentId;
  room.parentId = parentId;
  try {
    assertSharedStateSafe();
  } catch (e) {
    room.parentId = before;
    throw e;
  }
  db.prepare("UPDATE rooms SET parent_id = ? WHERE id = ?").run(parentId, roomId);
  events.emit("room", room);
  const viewers = new Set(beforeViewers);
  for (const m of allMembers()) if (m.kind === "human" && !m.disabled && canSee(m, roomId)) viewers.add(m.handle);
  events.emit("invalidate", { handles: [...viewers] });
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
  const messages = recentMessages(room.id, limit).map((x) => viewFor(viewer, x));
  if (viewer?.kind === "agent") return { ...room, messages };
  const delivered = deliveriesOf(messages.map((x) => x.id));
  return { ...room, messages: messages.map((x) => ({ ...x, delivered: delivered.get(x.id) ?? [] })) };
}

/** Adds who got the message, for people's dashboards. */
export function withDeliveries(viewer: Member | undefined, msg: Message): Message {
  return viewer?.kind === "agent" ? msg : { ...msg, delivered: deliveriesOf([msg.id]).get(msg.id) ?? [] };
}

// --- members -----------------------------------------------------------------

/** Who answers for what a member does: the person behind an agent, or the person themselves. */
export const responsible = (m: Member) => (m.kind === "agent" ? (m.owner ?? m.handle) : m.handle);

export const isAdmin = (m: Member | undefined | null) => !!m && !m.disabled && (m.role === "owner" || m.role === "admin");

function isReservedHandle(handle: string): boolean {
  return (db.prepare("SELECT handle_hash FROM reserved_handles").all() as { handle_hash: string }[]).some((row) =>
    verifyPassword(handle, row.handle_hash),
  );
}

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
  const handleTaken = (handle: string) => members.has(handle) || isReservedHandle(handle);
  if (input.handle && handleTaken(wanted)) throw new Error(`handle @${wanted} is taken`);
  let handle = wanted;
  if (!input.handle) for (let i = 2; handleTaken(handle) || BROADCAST.has(handle); i++) handle = `${wanted}-${i}`;
  const owner = input.owner ? members.get(input.owner) : undefined;
  if (input.owner && (!owner || owner.disabled || owner.kind !== "human")) throw new Error(`no such owner @${input.owner}`);
  const email = input.email?.trim().toLowerCase() || null;
  if (email && !EMAIL.test(email)) throw new Error("that email address doesn't look right");
  if (email && [...members.values()].some((m) => m.email === email)) throw new Error("someone already uses that email address");
  const member: Member = {
    handle,
    name: input.name.trim().slice(0, 80),
    kind,
    org: (owner?.org ?? input.org).trim().slice(0, 80),
    scopeRoomId: input.scopeRoomId,
    adapter: input.adapter ?? (kind === "human" ? "dashboard" : "inbox"),
    role: kind === "human" ? (input.role ?? "member") : null,
    email,
    owner: input.owner ?? null,
    paused: false,
    disabled: false,
    prefs: { ...DEFAULT_PREFS },
    twoFactor: false,
    createdAt: new Date().toISOString(),
  };
  members.set(member.handle, member);
  try {
    assertSharedStateSafe();
  } catch (e) {
    members.delete(member.handle);
    throw e;
  }
  members.delete(member.handle);
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
  if (m.kind === "agent" && m.owner) {
    const owner = members.get(m.owner);
    if (!owner || owner.disabled || owner.kind !== "human") throw new Error(`no such owner @${m.owner}`);
    next.org = owner.org;
  }

  // Simulate the person's agents following an org/scope change, then reject
  // the whole change if it would expose private instructions cross-company.
  const simulated = [m, ...(m.kind === "human" ? [...members.values()].filter((a) => a.kind === "agent" && a.owner === m.handle) : [])].map((x) => ({
    member: x,
    org: x.org,
    scopeRoomId: x.scopeRoomId,
    disabled: x.disabled,
  }));
  Object.assign(m, next);
  if (m.kind === "human")
    for (const a of [...members.values()].filter((x) => x.kind === "agent" && x.owner === m.handle)) {
      a.org = m.org;
      if (!canSee(m, a.scopeRoomId!)) a.disabled = true;
    }
  try {
    assertSharedStateSafe();
  } catch (e) {
    for (const old of simulated) Object.assign(old.member, { org: old.org, scopeRoomId: old.scopeRoomId, disabled: old.disabled });
    throw e;
  }
  for (const old of simulated) Object.assign(old.member, { org: old.org, scopeRoomId: old.scopeRoomId, disabled: old.disabled });

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
      db.prepare("DELETE FROM agent_sessions WHERE handle = ?").run(x.handle);
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
  tx(() => {
    db.prepare("UPDATE members SET token_hash = ? WHERE handle = ?").run(sha256(token), handle);
    db.prepare("UPDATE agent_sessions SET expires_at = ? WHERE handle = ?").run(new Date().toISOString(), handle);
  });
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

// Presence: people are online while they hold an SSE connection. Agents are
// online while at least one named Warren session has a live lease.
const connections = new Map<string, number>();
export const AGENT_SESSION_LEASE_MS = 30_000;

const toAgentSession = (r: Row): AgentSession => ({
  id: r.id as string,
  handle: r.handle as string,
  name: r.name as string,
  createdAt: r.created_at as string,
  lastSeenAt: r.last_seen_at as string,
  expiresAt: r.expires_at as string,
});

function validSessionName(value: unknown): string {
  const name = String(value ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name))
    throw new Error("session name must use 1-64 lowercase letters, numbers, _ or -");
  if (BROADCAST.has(name)) throw new Error(`session name "${name}" is reserved`);
  return name;
}

export function activeAgentSessions(handle: string, now = new Date().toISOString()): AgentSession[] {
  return (db.prepare("SELECT * FROM agent_sessions WHERE handle = ? AND expires_at > ? ORDER BY name, created_at DESC").all(handle, now) as Row[]).map(
    toAgentSession,
  );
}

/** Latest known incarnation of every slot, including offline slots for the UI. */
export function publicAgentSessions(handle: string): PublicAgentSession[] {
  const now = new Date().toISOString();
  const rows = db
    .prepare(
      `SELECT s.* FROM agent_sessions s
       WHERE s.handle = ? AND s.created_at = (
         SELECT max(x.created_at) FROM agent_sessions x WHERE x.handle = s.handle AND x.name = s.name
       ) ORDER BY s.name`,
    )
    .all(handle) as Row[];
  return rows.map((r) => ({ name: r.name as string, online: (r.expires_at as string) > now, lastSeenAt: r.last_seen_at as string }));
}

export function createAgentSession(m: Member, value: unknown): AgentSession {
  if (m.kind !== "agent") throw new Error("only an agent can open an agent session");
  const name = validSessionName(value);
  const now = new Date();
  const at = now.toISOString();
  const session: AgentSession = {
    id: `wsess_${randomUUID().replaceAll("-", "")}`,
    handle: m.handle,
    name,
    createdAt: at,
    lastSeenAt: at,
    expiresAt: new Date(now.getTime() + AGENT_SESSION_LEASE_MS).toISOString(),
  };
  const wasOnline = isOnline(m.handle);
  tx(() => {
    // A restart atomically rebinds the human-readable slot to a new opaque id.
    db.prepare("UPDATE agent_sessions SET expires_at = ? WHERE handle = ? AND name = ? AND expires_at > ?").run(at, m.handle, name, at);
    db.prepare("INSERT INTO agent_sessions (id, handle, name, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      session.id,
      session.handle,
      session.name,
      session.createdAt,
      session.lastSeenAt,
      session.expiresAt,
    );
  });
  events.emit("agent_session", { handle: m.handle, sessions: publicAgentSessions(m.handle) });
  events.emit("member", publicMember(m));
  if (!wasOnline) events.emit("presence", { handle: m.handle, online: true });
  return session;
}

/** Reconnect the same live process after its transport was away past the lease. */
export function resumeAgentSession(m: Member, value: unknown, id: unknown): AgentSession {
  if (m.kind !== "agent") throw new Error("only an agent can resume an agent session");
  const name = validSessionName(value);
  const existing = agentSession(String(id ?? ""), m.handle, true);
  if (!existing || existing.name !== name) throw new Error("no such Warren session to resume");
  const latest = db.prepare("SELECT id FROM agent_sessions WHERE handle = ? AND name = ? ORDER BY created_at DESC LIMIT 1").get(m.handle, name) as
    | { id: string }
    | undefined;
  if (latest?.id !== existing.id) throw new Error("that slot has already been rebound to a newer Warren session");
  const now = new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + AGENT_SESSION_LEASE_MS).toISOString();
  const wasOnline = isOnline(m.handle);
  tx(() => {
    db.prepare("UPDATE agent_sessions SET expires_at = ? WHERE handle = ? AND name = ? AND id != ? AND expires_at > ?").run(at, m.handle, name, existing.id, at);
    db.prepare("UPDATE agent_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND handle = ?").run(at, expiresAt, existing.id, m.handle);
  });
  events.emit("agent_session", { handle: m.handle, sessions: publicAgentSessions(m.handle) });
  events.emit("member", publicMember(m));
  if (!wasOnline) events.emit("presence", { handle: m.handle, online: true });
  return { ...existing, lastSeenAt: at, expiresAt };
}

export function agentSession(id: string | undefined, handle?: string, includeExpired = false): AgentSession | undefined {
  if (!id) return undefined;
  const row = db.prepare(`SELECT * FROM agent_sessions WHERE id = ? ${handle ? "AND handle = ?" : ""}`).get(...([id, handle].filter(Boolean) as string[])) as
    | Row
    | undefined;
  if (!row || (!includeExpired && (row.expires_at as string) <= new Date().toISOString())) return undefined;
  return toAgentSession(row);
}

export function renewAgentSession(id: string, handle: string): AgentSession | undefined {
  const current = agentSession(id, handle);
  if (!current) return undefined;
  const now = new Date();
  const at = now.toISOString();
  const expiresAt = new Date(now.getTime() + AGENT_SESSION_LEASE_MS).toISOString();
  db.prepare("UPDATE agent_sessions SET last_seen_at = ?, expires_at = ? WHERE id = ? AND handle = ?").run(at, expiresAt, id, handle);
  return { ...current, lastSeenAt: at, expiresAt };
}

export function endAgentSession(id: string, handle: string): boolean {
  const wasOnline = isOnline(handle);
  const now = new Date().toISOString();
  const ended = Number(
    db.prepare("UPDATE agent_sessions SET expires_at = ?, last_seen_at = ? WHERE id = ? AND handle = ? AND expires_at > ?").run(
      now,
      now,
      id,
      handle,
      now,
    ).changes,
  );
  if (ended) {
    events.emit("agent_session", { handle, sessions: publicAgentSessions(handle) });
    const member = members.get(handle);
    if (member) events.emit("member", publicMember(member));
    if (wasOnline && !isOnline(handle)) events.emit("presence", { handle, online: false });
  }
  return ended > 0;
}

/** Expire leases and publish the resulting presence/slot changes. */
export function sweepAgentSessions(): number {
  const now = new Date().toISOString();
  const handles = (db.prepare("SELECT DISTINCT handle FROM agent_sessions WHERE expires_at <= ? AND last_seen_at != expires_at").all(now) as { handle: string }[]).map(
    (r) => r.handle,
  );
  // Mark already-reported expirations without deleting history used by the UI.
  const changed = Number(db.prepare("UPDATE agent_sessions SET last_seen_at = expires_at WHERE expires_at <= ? AND last_seen_at != expires_at").run(now).changes);
  for (const handle of handles) {
    events.emit("agent_session", { handle, sessions: publicAgentSessions(handle) });
    const member = members.get(handle);
    if (member) events.emit("member", publicMember(member));
    if (!isOnline(handle)) events.emit("presence", { handle, online: false });
  }
  return changed;
}

export function isOnline(handle: string): boolean {
  const m = members.get(handle);
  return (connections.get(handle) ?? 0) > 0 || (m?.kind === "agent" && activeAgentSessions(handle).length > 0);
}

/** Call on SSE connect (+1) and disconnect (-1); emits "presence" when online flips. */
export function trackConnection(m: Member, delta: 1 | -1) {
  const wasOnline = isOnline(m.handle);
  const count = connections.get(m.handle) ?? 0;
  const after = Math.max(0, count + delta);
  connections.set(m.handle, after);
  const online = isOnline(m.handle);
  if (wasOnline !== online) events.emit("presence", { handle: m.handle, online });
}

/** Tells open streams of `handle` to close: their credentials changed. */
function kick(handle: string) {
  events.emit("kick", handle);
}

/** Everyone who can see the room: these are the room's members. */
export function roomMembers(roomId: string): Member[] {
  return allMembers().filter((m) => canSee(m, roomId));
}

// --- personal settings, two-factor sign-in, approver keys ----------------------------

export function setPrefs(handle: string, patch: Partial<Prefs>): Member {
  const m = members.get(handle);
  if (!m) throw new Error(`no such member @${handle}`);
  const next = { ...m.prefs };
  if (patch.language !== undefined) {
    if (!["en", "cs"].includes(patch.language)) throw new Error("language must be en or cs");
    next.language = patch.language;
  }
  if (patch.theme !== undefined) {
    if (!["system", "light", "dark"].includes(patch.theme)) throw new Error("theme must be system, light or dark");
    next.theme = patch.theme;
  }
  for (const k of ["holdAllForeign", "emailOnHold"] as const)
    if (patch[k] !== undefined) {
      if (typeof patch[k] !== "boolean") throw new Error(`${k} must be true or false`);
      next[k] = patch[k];
    }
  db.prepare("UPDATE members SET prefs = ? WHERE handle = ?").run(JSON.stringify(next), handle);
  m.prefs = next;
  return m;
}

type TotpRow = {
  totp_secret: string | null;
  totp_pending: string | null;
  totp_pending_session_hash: string | null;
  totp_pending_expires_at: string | null;
  totp_last_step: number | null;
  recovery_codes: string | null;
};
const totpRow = (handle: string) =>
  db
    .prepare(
      "SELECT totp_secret, totp_pending, totp_pending_session_hash, totp_pending_expires_at, totp_last_step, recovery_codes FROM members WHERE handle = ?",
    )
    .get(handle) as TotpRow | undefined;

export const totpSecretOf = (handle: string) => totpRow(handle)?.totp_secret ?? null;

export function pendingTotpOf(handle: string, sessionId: string): { secret: string; expiresAt: string } | null {
  const row = totpRow(handle);
  if (
    !row?.totp_pending ||
    row.totp_pending_session_hash !== sha256(sessionId) ||
    !row.totp_pending_expires_at ||
    row.totp_pending_expires_at <= new Date().toISOString()
  ) {
    if (row?.totp_pending && row.totp_pending_expires_at && row.totp_pending_expires_at <= new Date().toISOString())
      db.prepare(
        "UPDATE members SET totp_pending = NULL, totp_pending_session_hash = NULL, totp_pending_expires_at = NULL WHERE handle = ?",
      ).run(handle);
    return null;
  }
  return { secret: row.totp_pending, expiresAt: row.totp_pending_expires_at };
}

export function setPendingTotp(handle: string, secret: string, sessionId: string): string {
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare(
    "UPDATE members SET totp_pending = ?, totp_pending_session_hash = ?, totp_pending_expires_at = ? WHERE handle = ?",
  ).run(secret, sha256(sessionId), expiresAt, handle);
  return expiresAt;
}

const canonicalRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[\s-]/g, "");

/** Turns two-factor on with the confirmed secret; stores recovery codes with scrypt. */
export function enableTotp(handle: string, secret: string, recoveryCodes: string[], step: number, sessionId: string): boolean {
  const done = db.prepare(
    `UPDATE members
        SET totp_secret = ?, totp_pending = NULL, totp_pending_session_hash = NULL,
            totp_pending_expires_at = NULL, totp_last_step = ?, recovery_codes = ?
      WHERE handle = ? AND totp_pending = ? AND totp_pending_session_hash = ? AND totp_pending_expires_at > ?`,
  ).run(
    secret,
    step,
    JSON.stringify(recoveryCodes.map((c) => hashPassword(canonicalRecoveryCode(c)))),
    handle,
    secret,
    sha256(sessionId),
    new Date().toISOString(),
  ).changes;
  if (done) members.get(handle)!.twoFactor = true;
  return done === 1;
}

export function disableTotp(handle: string) {
  db.prepare(
    `UPDATE members SET totp_secret = NULL, totp_pending = NULL, totp_pending_session_hash = NULL,
                        totp_pending_expires_at = NULL, totp_last_step = NULL, recovery_codes = NULL
      WHERE handle = ?`,
  ).run(handle);
  const m = members.get(handle);
  if (m) m.twoFactor = false;
}

/** Atomically rejects a TOTP timestep already used for this account. */
export function useTotpStep(handle: string, step: number): boolean {
  return (
    db
      .prepare("UPDATE members SET totp_last_step = ? WHERE handle = ? AND totp_secret IS NOT NULL AND (totp_last_step IS NULL OR totp_last_step < ?)")
      .run(step, handle, step).changes === 1
  );
}

/** Uses up a recovery code; false when it isn't one of theirs (or was used). */
export function useRecoveryCode(handle: string, code: unknown): boolean {
  if (typeof code !== "string") return false;
  const hashes: string[] = JSON.parse(totpRow(handle)?.recovery_codes ?? "[]");
  const normalized = canonicalRecoveryCode(code);
  const index = hashes.findIndex((hash) => verifyPassword(normalized, hash));
  if (index === -1) return false;
  hashes.splice(index, 1);
  db.prepare("UPDATE members SET recovery_codes = ? WHERE handle = ?").run(JSON.stringify(hashes), handle);
  return true;
}

export const recoveryCodesLeft = (handle: string) => (JSON.parse(totpRow(handle)?.recovery_codes ?? "[]") as string[]).length;

/** Replaces every recovery code at once; callers must reauthenticate first. */
export function replaceRecoveryCodes(handle: string, recoveryCodes: string[]): void {
  db.prepare("UPDATE members SET recovery_codes = ? WHERE handle = ? AND totp_secret IS NOT NULL").run(
    JSON.stringify(recoveryCodes.map((c) => hashPassword(canonicalRecoveryCode(c)))),
    handle,
  );
}

export interface ApproverKey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A key that lets its person approve held messages for their own agents, and nothing else. Returned once. */
export function createApproverKey(handle: string, label: string): { key: string; id: string } {
  const key = newSecret("wa");
  const id = randomUUID();
  db.prepare("INSERT INTO approver_keys (id, handle, key_hash, label, created_at) VALUES (?, ?, ?, ?, ?)").run(
    id,
    handle,
    sha256(key),
    String(label || "agent session").trim().slice(0, 60),
    new Date().toISOString(),
  );
  return { key, id };
}

export function approverKeys(handle: string): ApproverKey[] {
  return (db.prepare("SELECT id, label, created_at, last_used_at FROM approver_keys WHERE handle = ? ORDER BY created_at").all(handle) as Row[]).map((r) => ({
    id: r.id as string,
    label: r.label as string,
    createdAt: r.created_at as string,
    lastUsedAt: (r.last_used_at as string | null) ?? null,
  }));
}

export function deleteApproverKey(handle: string, id: string): boolean {
  return db.prepare("DELETE FROM approver_keys WHERE handle = ? AND id = ?").run(handle, id).changes === 1;
}

export function byApproverKey(key: string | undefined): Member | undefined {
  const m = approverMember(key);
  if (m) db.prepare("UPDATE approver_keys SET last_used_at = ? WHERE key_hash = ?").run(new Date().toISOString(), sha256(key!));
  return m;
}

function approverMember(key: string | undefined): Member | undefined {
  if (!key?.startsWith("wa_")) return undefined;
  const row = db.prepare("SELECT handle FROM approver_keys WHERE key_hash = ?").get(sha256(key)) as { handle: string } | undefined;
  const m = row ? members.get(row.handle) : undefined;
  if (!m || m.disabled) return undefined;
  return m;
}

export const approverHandleForKey = (key: string | undefined) => approverMember(key)?.handle;

// --- privacy: export, erasure, retention ---------------------------------------------

/** Everything the hub stores about a person and their agents (GDPR art. 15 and 20). */
export function exportFor(handle: string) {
  return tx(() => {
    const m = members.get(handle)!;
    const agents = [...members.values()].filter((a) => a.owner === handle);
    const handles = [handle, ...agents.map((a) => a.handle)];
    const mine = new Set(handles);
    const list = JSON.stringify(handles);
    const deliveries = db
      .prepare(
        `SELECT message_id, handle, at FROM deliveries
          WHERE handle IN (SELECT value FROM json_each(?))
             OR message_id IN (SELECT id FROM messages WHERE from_handle IN (SELECT value FROM json_each(?)))
          ORDER BY at`,
      )
      .all(list, list) as Row[];
    const sessionDeliveries = db
      .prepare(
        `SELECT message_id, handle, session_name, at FROM session_deliveries
          WHERE handle IN (SELECT value FROM json_each(?))
             OR message_id IN (SELECT id FROM messages WHERE from_handle IN (SELECT value FROM json_each(?)))
          ORDER BY at`,
      )
      .all(list, list) as Row[];
    const deliveredIds = new Set(deliveries.map((r) => r.message_id as string));
    const mentionsMine = (value: unknown): boolean => {
      if (typeof value === "string") return mine.has(value);
      if (Array.isArray(value)) return value.some(mentionsMine);
      return !!value && typeof value === "object" && Object.entries(value).some(([key, child]) => mine.has(key) || mentionsMine(child));
    };
    const messages = (db.prepare("SELECT * FROM messages ORDER BY seq").all() as Row[])
      .map(toMessage)
      .filter(
        (msg) =>
          mine.has(msg.from) ||
          msg.mentions.some((h) => mine.has(h)) ||
          msg.metadata.to.some((target) => mine.has(target.agent)) ||
          deliveredIds.has(msg.id) ||
          mentionsMine(msg.safety),
      );
    const email = m.email;
    const links = db
      .prepare(
        `SELECT id, purpose, email, org, scope_room_id, role, handle, created_by, created_at, expires_at, used_at, used_by
           FROM links
          WHERE handle IN (SELECT value FROM json_each(?))
             OR created_by IN (SELECT value FROM json_each(?))
             OR used_by IN (SELECT value FROM json_each(?))
             OR (? IS NOT NULL AND email = ?)
          ORDER BY created_at`,
      )
      .all(list, list, list, email, email) as Row[];
    const audits = (db.prepare("SELECT * FROM audit ORDER BY seq").all() as Row[])
      .map(toAudit)
      .filter((e) => mine.has(e.actor) || (!!e.target && mine.has(e.target)) || handles.some((h) => e.detail.includes(`@${h}`)));
    return {
      exportedAt: new Date().toISOString(),
      instance: instanceName(),
      account: { ...publicMember(m), email: m.email, prefs: m.prefs, twoFactor: m.twoFactor, approverKeys: approverKeys(handle) },
      agents: agents.map(publicMember),
      messages,
      deliveries,
      sessionDeliveries,
      agentSessions: db
        .prepare("SELECT id, handle, name, created_at, last_seen_at, expires_at FROM agent_sessions WHERE handle IN (SELECT value FROM json_each(?))")
        .all(list),
      claims: allRooms().flatMap((r) => r.claims.filter((c) => mine.has(c.by))),
      roomsCreated: allRooms().filter((r) => mine.has(r.createdBy ?? "")),
      audit: audits,
      sessions: (db.prepare("SELECT created_at, expires_at, authenticated_at FROM sessions WHERE handle = ?").all(handle) as Row[]).map((r) => ({
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        authenticatedAt: r.authenticated_at,
      })),
      links,
    };
  });
}

/**
 * Deletes a person's account (GDPR art. 17): their name, email, password,
 * two-factor and keys go; their agents are removed; their handle stays taken
 * so old threads still read. With `deleteMessages`, what they and their agents
 * wrote is deleted too; otherwise it stays, signed "former member".
 */
export function eraseMember(handle: string, deleteMessages: boolean, actor: string) {
  const m = members.get(handle);
  if (!m) throw new Error(`no such member @${handle}`);
  const agents = [...members.values()].filter((a) => a.owner === handle);
  const originals = [m, ...agents];
  const handles = originals.map((x) => x.handle);
  const list = JSON.stringify(handles);
  const aliases = new Map(handles.map((h) => [h, `former-${randomUUID().slice(0, 12)}`]));
  const oldEmail = m.email;
  const erasedAt = new Date().toISOString();
  // Capture the audience before the account and its room relationships vanish.
  // The event itself carries no private data; it only asks authorized clients
  // to replace their already-scoped snapshots.
  const invalidationHandles = allMembers()
    .filter((member) => member.kind === "human" && !member.disabled)
    .map((member) => member.handle);
  const touchedRooms = new Set<string>();
  const replaceRefs = (text: string) => {
    for (const [old, alias] of aliases)
      text = text.replace(new RegExp(`@${old.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9_-])`, "gi"), `@${alias}`);
    return text;
  };
  tx(() => {
    for (const original of originals) {
      const alias = aliases.get(original.handle)!;
      db.prepare(
        `INSERT INTO members
          (handle, name, kind, org, scope_room_id, adapter, role, email, password_hash, token_hash,
           owner_handle, paused, disabled, created_at, prefs, totp_secret, totp_pending, recovery_codes,
           totp_pending_session_hash, totp_pending_expires_at, totp_last_step)
         VALUES (?, 'Former member', ?, 'former', ?, ?, NULL, NULL, NULL, NULL, ?, 0, 1, ?, '{}',
                 NULL, NULL, NULL, NULL, NULL, NULL)`,
      ).run(alias, original.kind, original.scopeRoomId, original.adapter, original.owner ? aliases.get(original.owner) ?? null : null, original.createdAt);
      db.prepare("INSERT INTO reserved_handles (handle_hash, erased_at) VALUES (?, ?)").run(hashPassword(original.handle), erasedAt);
    }
    db.prepare("DELETE FROM sessions WHERE handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM approver_keys WHERE handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM claims WHERE by_handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM deliveries WHERE handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM session_deliveries WHERE handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare("DELETE FROM agent_sessions WHERE handle IN (SELECT value FROM json_each(?))").run(list);
    db.prepare(
      `DELETE FROM links
        WHERE handle IN (SELECT value FROM json_each(?))
           OR created_by IN (SELECT value FROM json_each(?))
           OR used_by IN (SELECT value FROM json_each(?))
           OR (? IS NOT NULL AND email = ?)`,
    ).run(list, list, list, oldEmail, oldEmail);

    for (const row of db.prepare("SELECT * FROM messages ORDER BY seq").all() as Row[]) {
      const msg = toMessage(row);
      if (deleteMessages && aliases.has(msg.from)) {
        touchedRooms.add(msg.roomId);
        db.prepare("DELETE FROM messages WHERE id = ?").run(msg.id);
        continue;
      }
      let changed = false;
      const from = aliases.get(msg.from) ?? msg.from;
      if (from !== msg.from) changed = true;
      const mentions = msg.mentions.map((h) => aliases.get(h) ?? h);
      if (mentions.some((h, i) => h !== msg.mentions[i])) changed = true;
      const targets = msg.metadata.to.map((target) => ({ ...target, agent: aliases.get(target.agent) ?? target.agent }));
      if (targets.some((target, i) => target.agent !== msg.metadata.to[i].agent)) changed = true;
      const text = replaceRefs(msg.text);
      if (text !== msg.text) changed = true;
      const safety: Safety = structuredClone(msg.safety);
      if (safety.reviewedBy && aliases.has(safety.reviewedBy)) {
        safety.reviewedBy = aliases.get(safety.reviewedBy);
        changed = true;
      }
      if (safety.gate?.by && aliases.has(safety.gate.by)) {
        safety.gate.by = aliases.get(safety.gate.by);
        changed = true;
      }
      // A contract-change gate can only be decided by the sender's company.
      // Once that sender is erased and pseudonymized as "former", leaving the
      // gate pending would make the message impossible to resolve.
      if (aliases.has(msg.from) && gateDecision(safety) === "pending") {
        safety.gate = { decision: "rejected", by: aliases.get(msg.from), at: erasedAt };
        changed = true;
      }
      if (safety.approvals) {
        const approvals: Record<string, Approval> = {};
        for (const [key, approval] of Object.entries(safety.approvals)) {
          const renamed = aliases.get(key) ?? key;
          const copy = { ...approval, agents: approval.agents.map((a) => aliases.get(a) ?? a) };
          if (copy.by && aliases.has(copy.by)) copy.by = aliases.get(copy.by);
          if (aliases.has(key) && copy.decision === "pending") Object.assign(copy, { decision: "rejected" as const, by: renamed, at: erasedAt });
          approvals[renamed] = copy;
          if (renamed !== key || copy.by !== approval.by || copy.agents.some((a, i) => a !== approval.agents[i]) || copy.decision !== approval.decision)
            changed = true;
        }
        safety.approvals = approvals;
        safety.status = settle(safety);
      }
      if (!safety.approvals && changed) safety.status = settle(safety);
      if (changed) {
        touchedRooms.add(msg.roomId);
        db.prepare(
          "UPDATE messages SET from_handle = ?, org = ?, text = ?, mentions = ?, targets = ?, safety = ?, from_session_id = ?, session_name_snapshot = ? WHERE id = ?",
        ).run(
          from,
          aliases.has(msg.from) ? "former" : msg.org,
          text,
          JSON.stringify(mentions),
          JSON.stringify(targets),
          JSON.stringify(safety),
          aliases.has(msg.from) ? null : msg.metadata.from.sessionId ?? null,
          aliases.has(msg.from) ? null : msg.metadata.from.sessionNameSnapshot ?? null,
          msg.id,
        );
      }
    }

    for (const row of db.prepare("SELECT id, created_by, name, context FROM rooms").all() as Row[])
      db.prepare("UPDATE rooms SET created_by = ?, name = ?, context = ? WHERE id = ?").run(
        aliases.get(row.created_by as string) ?? (row.created_by as string | null),
        replaceRefs(row.name as string),
        replaceRefs(row.context as string),
        row.id as string,
      );
    for (const row of db.prepare("SELECT id, task FROM claims").all() as Row[])
      db.prepare("UPDATE claims SET task = ? WHERE id = ?").run(replaceRefs(row.task as string), row.id as string);
    for (const row of db.prepare("SELECT id, actor, target, detail FROM audit").all() as Row[])
      db.prepare("UPDATE audit SET actor = ?, target = ?, detail = ? WHERE id = ?").run(
        aliases.get(row.actor as string) ?? (row.actor as string),
        aliases.get(row.target as string) ?? (row.target as string | null),
        replaceRefs(row.detail as string),
        row.id as string,
      );
    for (const [old, alias] of aliases)
      db.prepare("UPDATE members SET owner_handle = ? WHERE owner_handle = ?").run(alias, old);
    db.prepare("DELETE FROM members WHERE handle IN (SELECT value FROM json_each(?))").run(list);
  });
  load();
  for (const original of originals) {
    kick(original.handle);
    events.emit("member", publicMember({ ...original, disabled: true, name: "Former member", email: null }));
  }
  for (const roomId of touchedRooms) events.emit("room_messages_deleted", { roomId });
  events.emit("invalidate", { handles: invalidationHandles });
  const alias = aliases.get(handle)!;
  audit({ type: "member", roomId: "*", actor: actor === handle ? alias : aliases.get(actor) ?? actor, target: alias, detail: "erased an account and its agent identifiers" });
}

export const retentionDays = () => Number(getMeta("retention_days") ?? 0);
export const setRetentionDays = (days: number) => setMeta("retention_days", String(Math.max(0, Math.floor(days) || 0)));
export const privacyContact = () => getMeta("privacy_contact") ?? "";
export const setPrivacyContact = (v: string) => setMeta("privacy_contact", String(v ?? "").trim().slice(0, 200));

/** Deletes messages older than the retention period, expired sessions and links. Returns how many messages went. */
export function sweep(): number {
  const now = new Date();
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  const usedCutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  db.prepare("DELETE FROM links WHERE (used_at IS NULL AND expires_at < ?) OR (used_at IS NOT NULL AND used_at < ?)").run(now.toISOString(), usedCutoff);
  const days = retentionDays();
  if (!days) return 0;
  const cutoff = new Date(now.getTime() - days * 86_400_000).toISOString();
  const touched = (db.prepare("SELECT DISTINCT room_id FROM messages WHERE at < ?").all(cutoff) as { room_id: string }[]).map((r) => r.room_id);
  const n = db.prepare("DELETE FROM messages WHERE at < ?").run(cutoff).changes;
  if (n) {
    for (const roomId of touched) events.emit("room_messages_deleted", { roomId });
    audit({ type: "room", roomId: "*", actor: "hub", detail: `deleted ${n} messages older than ${days} days (retention)` });
  }
  return Number(n);
}

// --- sessions ------------------------------------------------------------------

const SESSION_DAYS = 30;

/** Signs a person in: returns the session id for the cookie (stored hashed). */
export function createSession(handle: string, recentlyAuthenticated = true): { id: string; expiresAt: Date } {
  const id = newSecret("ws");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now.toISOString());
  db.prepare("INSERT INTO sessions (id_hash, handle, created_at, expires_at, authenticated_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(id),
    handle,
    now.toISOString(),
    expiresAt.toISOString(),
    recentlyAuthenticated ? now.toISOString() : null,
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

/** Recent password/second-factor authentication for sensitive enrollment. */
export function sessionRecentlyAuthenticated(id: string, handle: string, withinMs = 10 * 60_000): boolean {
  const row = db.prepare("SELECT authenticated_at FROM sessions WHERE id_hash = ? AND handle = ?").get(sha256(id), handle) as
    | { authenticated_at: string | null }
    | undefined;
  return !!row?.authenticated_at && Date.now() - Date.parse(row.authenticated_at) <= withinMs;
}

export function markSessionAuthenticated(id: string, handle: string) {
  db.prepare("UPDATE sessions SET authenticated_at = ? WHERE id_hash = ? AND handle = ?").run(new Date().toISOString(), sha256(id), handle);
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

// @handle and @handle/slot, not preceded by a word character (emails).
// Code spans and blocks are skipped. A slash is considered a slot only when
// the handle belongs to a member of the room.
const MENTION = /(^|[^\w@.\/-])@([a-z0-9][a-z0-9_-]*)(?:\/([a-z0-9][a-z0-9_-]*))?(?![\w-]|\.\w)/gi;
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;
const BROADCAST = new Set(["room", "here", "all"]);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;

/** Handles mentioned in `text` that are members of the room, plus whether @room was used. */
export function parseMentions(text: string, roomId: string): { mentions: string[]; mentionsRoom: boolean; targets: MessageTarget[] } {
  const found = new Set<string>();
  const targets = new Map<string, MessageTarget>();
  let mentionsRoom = false;
  for (const [, , raw, rawSession] of text.replace(CODE, " ").matchAll(MENTION)) {
    const handle = raw.toLowerCase();
    if (BROADCAST.has(handle) && !rawSession) mentionsRoom = true;
    else {
      const m = members.get(handle);
      if (m && canSee(m, roomId)) {
        const sessionName = rawSession?.toLowerCase();
        // Preserve npm scopes and path-like prose: slash syntax is an address
        // only for a slot the hub has actually seen for this agent.
        if (sessionName && (m.kind !== "agent" || !publicAgentSessions(m.handle).some((session) => session.name === sessionName))) continue;
        found.add(handle);
        targets.set(`${handle}\0${sessionName ?? ""}`, { agent: handle, ...(sessionName ? { sessionName } : {}) });
      }
    }
  }
  return { mentions: [...found], mentionsRoom, targets: [...targets.values()] };
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
  metadata: {
    from: {
      agent: r.from_handle as string,
      ...(r.from_session_id ? { sessionId: r.from_session_id as string } : {}),
      ...(r.session_name_snapshot
        ? { sessionName: r.session_name_snapshot as string, sessionNameSnapshot: r.session_name_snapshot as string }
        : {}),
    },
    to: JSON.parse((r.targets as string | null) ?? "[]"),
  },
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

/** Whose decision lets a message from another company reach this agent: its person, or its company when nobody owns it. */
export const approvalKey = (agent: Member) => agent.owner ?? `org:${agent.org}`;

/** True when `m` decides for `key`: it's them, or `org:<their org>` for agents nobody owns. */
const decidesFor = (m: Member, key: string) => key === m.handle || key === `org:${m.org}`;

/**
 * Posts a message. Safety, in order:
 *  1. secrets are masked;
 *  2. text that looks like an attack, from another company, is held separately
 *     for every person whose agents are in the room: each one decides for their
 *     own agents (people who turned on "hold everything from other companies"
 *     get every foreign message to their agents held the same way);
 *  3. agents talking without a person, and agents' contract changes under the
 *     room's approval policy, close a room-wide gate until a person decides.
 */
export function post(m: Member, roomId: string, kind: MessageKind, text: string, sourceSession?: AgentSession): Message {
  if (!canSee(m, roomId)) throw new Error(`no access to room ${roomId}`);
  if (m.paused) throw new Error(`@${m.handle} is paused by a person of ${m.org}; ask them to resume you`);
  if (typeof text !== "string" || !text.trim()) throw new Error("text is required");
  if (text.length > 20_000) throw new Error("messages are at most 20 000 characters");
  if (!MESSAGE_KINDS.includes(kind)) throw new Error(`kind must be one of ${MESSAGE_KINDS.join(", ")}`);
  const room = rooms.get(roomId)!;

  const clean = redactSecrets(text);
  const flags = injectionFlags(clean.text);
  const mentioned = parseMentions(clean.text, roomId);
  const reaches = (a: Member) => mentioned.mentionsRoom || mentioned.mentions.includes(a.handle);

  const approvals: Record<string, Approval> = {};
  let strict = false;
  for (const a of roomMembers(roomId)) {
    if (a.kind !== "agent" || a.org === m.org) continue;
    const owner = a.owner ? members.get(a.owner) : undefined;
    const holdAll = !!owner?.prefs.holdAllForeign && reaches(a);
    if (!flags.length && !holdAll) continue;
    strict ||= holdAll && !flags.length;
    const key = approvalKey(a);
    (approvals[key] ??= { decision: "pending", agents: [] }).agents.push(a.handle);
  }
  if (strict) flags.push("strict");

  const loop = m.kind === "agent" && agentStreak(roomId) >= LOOP_LIMIT;
  if (loop) flags.push("agent-loop");
  const needsApproval = room.policy.approveContractChanges && kind === "contract_change" && m.kind === "agent";
  if (needsApproval) flags.push("needs-approval");

  const safety: Safety = { status: "delivered", flags, redactions: clean.redactions };
  if (loop || needsApproval) safety.gate = { decision: "pending" };
  if (Object.keys(approvals).length) safety.approvals = approvals;
  safety.status = settle(safety);

  const msg: Message = {
    id: randomUUID(),
    roomId,
    from: m.handle,
    fromKind: m.kind,
    org: m.org,
    kind,
    text: clean.text,
    mentions: mentioned.mentions,
    mentionsRoom: mentioned.mentionsRoom,
    metadata: {
      from: {
        agent: m.handle,
        ...(sourceSession
          ? { sessionId: sourceSession.id, sessionName: sourceSession.name, sessionNameSnapshot: sourceSession.name }
          : {}),
      },
      to: mentioned.targets,
    },
    safety,
    at: new Date().toISOString(),
  };
  db.prepare(
    `INSERT INTO messages (id, room_id, from_handle, from_kind, org, kind, text, mentions, mentions_room, safety, at,
                           from_session_id, session_name_snapshot, targets)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    msg.id,
    roomId,
    msg.from,
    msg.fromKind,
    msg.org,
    kind,
    msg.text,
    JSON.stringify(msg.mentions),
    msg.mentionsRoom ? 1 : 0,
    JSON.stringify(safety),
    msg.at,
    sourceSession?.id ?? null,
    sourceSession?.name ?? null,
    JSON.stringify(mentioned.targets),
  );
  events.emit("message", msg);
  if (clean.redactions.length)
    audit({ type: "redacted", roomId, actor: "hub", target: msg.id, detail: `masked ${clean.redactions.join(", ")} in a message from @${m.handle}` });
  if (safety.status === "held") {
    const who = Object.keys(approvals).map((k) => (k.startsWith("org:") ? k.slice(4) : "@" + k));
    audit({
      type: "held",
      roomId,
      actor: "hub",
      target: msg.id,
      detail: `held a message from @${m.handle}: ${flags.join(", ")}${who.length ? `; waiting for ${who.join(", ")}` : ""}`,
    });
    // Tell the agents it was meant for (without the text) and their people.
    events.emit("held", msg);
  }
  return msg;
}

export function getMessage(id: string): Message | undefined {
  const row = db.prepare("SELECT * FROM messages WHERE id = ?").get(String(id)) as Row | undefined;
  return row ? toMessage(row) : undefined;
}

/** What `m` could decide on a held message: the room-wide gate, and the agents they answer for. */
export function decisionsFor(m: Member, msg: Message): { gate: boolean; keys: string[] } {
  const s = msg.safety;
  if (m.kind !== "human" || m.disabled || msg.from === m.handle || !canSee(m, msg.roomId)) return { gate: false, keys: [] };
  const gate =
    gateDecision(s) === "pending" &&
    // A contract change is approved by the people of the company that proposed it; a loop by any person.
    (!s.flags.includes("needs-approval") || m.org === msg.org);
  const keys = Object.entries(s.approvals ?? {})
    .filter(([key, a]) => a.decision === "pending" && decidesFor(m, key))
    .map(([key]) => key);
  return { gate, keys };
}

/**
 * A person releases or rejects a held message: the room-wide gate if they may
 * decide it (scope "gate"), otherwise their own agents' copy (scope "agents").
 * Agents get a released message pushed as if it had just been posted.
 */
export function review(m: Member, messageId: string, decision: "release" | "reject", scope?: "gate" | "agents"): Message {
  const msg = getMessage(messageId);
  if (!msg || !canSee(m, msg.roomId)) throw new Error(`no such message ${messageId}`);
  if (m.kind !== "human") throw new Error("only a person can review held messages");
  if (msg.from === m.handle) throw new Error("you can't review your own message");
  if (msg.safety.status !== "held") throw new Error(`message is ${msg.safety.status}, not held`);
  const can = decisionsFor(m, msg);
  const useGate = scope === "gate" || (scope === undefined && can.gate);
  if (decision === "release" && !useGate && m.org === msg.org)
    throw new Error("the sender's company can never release its own held message");
  const result: Decision = decision === "release" ? "released" : "rejected";
  const now = new Date().toISOString();
  let releasedKeys: string[] = [];

  if (useGate) {
    if (!can.gate) {
      if (gateDecision(msg.safety) !== "pending") throw new Error("nothing room-wide to decide on this message");
      throw new Error(`only a person of ${msg.org} can approve @${msg.from}'s contract change`);
    }
    msg.safety.gate = { decision: result, by: m.handle, at: now };
    // A room-wide rejection wins over every per-owner release. Resolve all
    // remaining approvals too, so no dashboard offers an impossible action.
    if (result === "rejected") {
      for (const approval of Object.values(msg.safety.approvals ?? {}))
        if (approval.decision === "pending") Object.assign(approval, { decision: "rejected", by: m.handle, at: now });
    }
  } else {
    if (!can.keys.length) {
      const waiting = Object.entries(msg.safety.approvals ?? {})
        .filter(([, a]) => a.decision === "pending")
        .map(([k, a]) => `${k.startsWith("org:") ? `a person of ${k.slice(4)}` : "@" + k} (for ${a.agents.map((x) => "@" + x).join(", ")})`);
      if (gateDecision(msg.safety) === "pending") throw new Error(`only a person of ${msg.org} can approve @${msg.from}'s contract change`);
      throw new Error(
        waiting.length
          ? `each person decides for their own agents: this waits for ${waiting.join(", ")}`
          : "nothing here for you to decide",
      );
    }
    for (const key of can.keys) Object.assign(msg.safety.approvals![key], { decision: result, by: m.handle, at: now });
    if (result === "released") releasedKeys = can.keys;
  }
  msg.safety.reviewedBy = m.handle;
  msg.safety.status = settle(msg.safety);
  db.prepare("UPDATE messages SET safety = ? WHERE id = ?").run(JSON.stringify(msg.safety), msg.id);
  events.emit("message_update", msg);
  audit({
    type: result,
    roomId: msg.roomId,
    actor: m.handle,
    target: msg.id,
    detail: `${result} @${msg.from}'s held message${useGate ? "" : ` for ${can.keys.map((k) => (k.startsWith("org:") ? k.slice(4) + "'s agents" : "@" + k + "'s agents")).join(", ")}`} (${msg.safety.flags.join(", ")})`,
  });
  // Now reaches the agents' streams; each stream checks which agents may have it.
  if (result === "released" && (useGate || releasedKeys.length)) events.emit("message", msg);
  return msg;
}

/** True when an agent may read the text: not held from it, not an unreviewed attack from another company. */
function agentMayRead(agent: Member, msg: Message): boolean {
  if (agent.handle === msg.from) return true;
  const s = msg.safety;
  const hasDecisionFields = s.gate !== undefined || s.approvals !== undefined;
  if ((s.status === "held" || s.status === "rejected") && !hasDecisionFields) return false;
  if (gateDecision(s) === "pending" || gateDecision(s) === "rejected") return false;
  const mine = s.approvals?.[approvalKey(agent)];
  if (mine) return Array.isArray(mine.agents) && mine.agents.includes(agent.handle) && mine.decision === "released";
  // Joined after the message was posted, or nobody had to decide for it: attacks from
  // another company stay hidden from agents unless someone released them for the room.
  if (agent.org !== msg.org && s.flags.some(isAttackFlag)) return false;
  return true;
}

/** What `viewer` may read of a message: agents don't see the text of messages held from them. */
export function viewFor(viewer: Member | undefined, msg: Message): Message {
  if (!viewer || viewer.kind !== "agent" || agentMayRead(viewer, msg)) return msg;
  const s = msg.safety;
  const reviewer = s.approvals?.[approvalKey(viewer)]?.by ?? s.gate?.by ?? s.reviewedBy;
  const note =
    s.status === "rejected" || gateDecision(s) === "rejected" || s.approvals?.[approvalKey(viewer)]?.decision === "rejected"
      ? `[rejected by @${reviewer ?? "a person"}]`
      : "[held for human review]";
  return { ...msg, text: note, mentions: [], mentionsRoom: false };
}

/** True when the message should be pushed to `m`: mentioned by handle or via @room, not their own, not held from them. */
export function isFor(m: Member, msg: Message): boolean {
  if (m.paused || msg.from === m.handle || !canSee(m, msg.roomId)) return false;
  if (m.kind === "agent" ? !agentMayRead(m, msg) : gateDecision(msg.safety) === "pending" || gateDecision(msg.safety) === "rejected") return false;
  return msg.mentionsRoom || msg.mentions.includes(m.handle);
}

const targetsFor = (msg: Message, handle: string) => {
  const structured = msg.metadata.to.filter((target) => target.agent === handle);
  // Messages written before the session migration addressed the agent inbox.
  return structured.length ? structured : msg.mentions.includes(handle) ? [{ agent: handle }] : [];
};

/** Whether a named process session may see an addressed message in its inbox. */
export function isInboxForSession(m: Member, msg: Message, session?: AgentSession): boolean {
  if (!isFor(m, msg)) return false;
  if (m.kind !== "agent") return true;
  const targets = targetsFor(msg, m.handle);
  if (msg.mentionsRoom) return !!session || activeAgentSessions(m.handle).length === 0;
  if (targets.some((target) => !target.sessionName)) return true;
  return !!session && targets.some((target) => target.sessionName === session.name);
}

/** Address matching without safety/readability checks (used for held notices). */
export function isAddressedToAgentSession(m: Member, msg: Message, session: AgentSession, soleInbox = true): boolean {
  const targets = targetsFor(msg, m.handle);
  if (msg.mentionsRoom) return true;
  if (targets.some((target) => target.sessionName === session.name)) return true;
  return soleInbox && targets.some((target) => !target.sessionName) && activeAgentSessions(m.handle).length === 1;
}

/** Push semantics: exact slot, @room broadcast, or a sole active session. */
export function isForAgentSession(m: Member, msg: Message, session: AgentSession): boolean {
  if (!isFor(m, msg) || session.handle !== m.handle) return false;
  return isAddressedToAgentSession(m, msg, session);
}

/**
 * Messages the member can see that arrived after `sinceId` (the last 500 when
 * omitted), minus their own. With `mentionsOnly`, just the ones addressed to
 * them, which then count as delivered.
 */
export function inbox(m: Member, sinceId?: string, mentionsOnly = false, session?: AgentSession): Message[] {
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
  const out = rows.filter((x) => !mentionsOnly || (m.kind === "agent" ? isInboxForSession(m, x, session) : isFor(m, x)));
  return out.map((x) => viewFor(m, x));
}

/** Atomically let one named session take an agent-inbox item. */
export function takeInboxMessage(m: Member, session: AgentSession, messageId: string): Message {
  const msg = getMessage(messageId);
  if (!msg || !isInboxForSession(m, msg, session)) throw new Error("no such inbox message");
  const targets = targetsFor(msg, m.handle);
  const general = !msg.mentionsRoom && targets.some((target) => !target.sessionName);
  const accepted = general ? markDelivered(msg, m.handle) : markSessionDelivered(msg, session);
  if (!accepted) throw new Error("that inbox message was already taken");
  return viewFor(m, msg);
}

// --- delivery: who got what, and catching up agents that were offline ---------------

/** Records that `handle` got the message; false when it already had. */
export function markDelivered(msg: Message, handle: string): boolean {
  const done = db.prepare("INSERT OR IGNORE INTO deliveries (message_id, handle, at) VALUES (?, ?, ?)").run(msg.id, handle, new Date().toISOString()).changes === 1;
  if (done) events.emit("delivery", { messageId: msg.id, roomId: msg.roomId, handle });
  return done;
}

export function wasDelivered(messageId: string, handle: string): boolean {
  return !!db.prepare("SELECT 1 FROM deliveries WHERE message_id = ? AND handle = ?").get(messageId, handle);
}

export function markSessionDelivered(msg: Message, session: AgentSession): boolean {
  const done =
    db
      .prepare("INSERT OR IGNORE INTO session_deliveries (message_id, handle, session_name, at) VALUES (?, ?, ?, ?)")
      .run(msg.id, session.handle, session.name, new Date().toISOString()).changes === 1;
  if (done) {
    // The dashboard's compact delivery line remains agent-level.
    markDelivered(msg, session.handle);
    events.emit("session_delivery", { messageId: msg.id, roomId: msg.roomId, handle: session.handle, sessionName: session.name });
  }
  return done;
}

export function wasDeliveredToSession(messageId: string, session: AgentSession): boolean {
  return !!db
    .prepare("SELECT 1 FROM session_deliveries WHERE message_id = ? AND handle = ? AND session_name = ?")
    .get(messageId, session.handle, session.name);
}

/** Handles that got each message pushed or read it from their inbox. */
export function deliveriesOf(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = db.prepare("SELECT message_id, handle FROM deliveries WHERE message_id IN (SELECT value FROM json_each(?))").all(JSON.stringify(ids)) as {
    message_id: string;
    handle: string;
  }[];
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r.handle]);
  return out;
}

export interface MessagePage {
  messages: Message[];
  nextSeq: number | null;
}

/**
 * One durable page of messages for `m` that were never acknowledged. Message
 * retention is the only expiry policy: when retention is disabled, an offline
 * agent can still catch up after any amount of time.
 */
export function undelivered(m: Member, afterSeq = 0, pageSize = 200): MessagePage {
  const visible = JSON.stringify(visibleRooms(m).map((r) => r.id));
  const limit = Math.max(1, Math.min(500, Math.floor(pageSize) || 200));
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id IN (SELECT value FROM json_each(?)) AND from_handle != ? AND seq > ?
       AND id NOT IN (SELECT message_id FROM deliveries WHERE handle = ?) ORDER BY seq LIMIT ?`,
    )
    .all(visible, m.handle, afterSeq, m.handle, limit) as Row[];
  return {
    messages: rows.map(toMessage).filter((x) => isFor(m, x)),
    nextSeq: rows.length === limit ? Number(rows[rows.length - 1].seq) : null,
  };
}

/** Durable catch-up scoped to one named slot. */
export function undeliveredForSession(m: Member, session: AgentSession, afterSeq = 0, pageSize = 200): MessagePage {
  const visible = JSON.stringify(visibleRooms(m).map((r) => r.id));
  const limit = Math.max(1, Math.min(500, Math.floor(pageSize) || 200));
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE room_id IN (SELECT value FROM json_each(?)) AND from_handle != ? AND seq > ?
       ORDER BY seq LIMIT ?`,
    )
    .all(visible, m.handle, afterSeq, limit) as Row[];
  const messages = rows.map(toMessage).filter((msg) => {
    if (!isForAgentSession(m, msg, session)) return false;
    const general = !msg.mentionsRoom && targetsFor(msg, m.handle).some((target) => !target.sessionName);
    return general ? !wasDelivered(msg.id, m.handle) : !wasDeliveredToSession(msg.id, session);
  });
  return { messages, nextSeq: rows.length === limit ? Number(rows[rows.length - 1].seq) : null };
}

/** One durable page of pending text-free hold notices for an agent. */
export function pendingHeld(m: Member, afterSeq = 0, pageSize = 200, session?: AgentSession): MessagePage {
  if (m.kind !== "agent" || m.paused) return { messages: [], nextSeq: null };
  const visible = JSON.stringify(visibleRooms(m).map((r) => r.id));
  const limit = Math.max(1, Math.min(500, Math.floor(pageSize) || 200));
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE room_id IN (SELECT value FROM json_each(?)) AND from_handle != ? AND seq > ?
        ORDER BY seq LIMIT ?`,
    )
    .all(visible, m.handle, afterSeq, limit) as Row[];
  const messages = rows.map(toMessage).filter((msg) => {
    const approval = msg.safety.approvals?.[approvalKey(m)];
    const addressed = session ? isAddressedToAgentSession(m, msg, session) : msg.mentionsRoom || msg.mentions.includes(m.handle);
    return (
      msg.safety.status === "held" &&
      addressed &&
      ((approval?.decision === "pending" && Array.isArray(approval.agents) && approval.agents.includes(m.handle)) || gateDecision(msg.safety) === "pending")
    );
  });
  return { messages, nextSeq: rows.length === limit ? Number(rows[rows.length - 1].seq) : null };
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

const GLOB_META = /[*?[{]/;

/**
 * A repository-relative lock spelling. Normalize separators and dot segments,
 * but reject absolute paths and attempts to escape above the repository root.
 */
function canonicalLockPattern(pattern: string): string {
  const raw = pattern.trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || raw.startsWith("/") || raw.startsWith("~") || /^[a-zA-Z]:/.test(raw))
    throw new Error(`"${pattern}" must be a repository-relative path`);
  const out: string[] = [];
  for (const segment of raw.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!out.length) throw new Error(`"${pattern}" escapes the repository`);
      if (GLOB_META.test(out[out.length - 1])) throw new Error(`"${pattern}" has an ambiguous dot segment after a glob`);
      out.pop();
      continue;
    }
    out.push(segment);
  }
  const canonical = out.join("/");
  const firstGlob = out.findIndex((segment) => GLOB_META.test(segment));
  const anchor = (firstGlob === -1 ? out : out.slice(0, firstGlob)).join("/");
  if (!canonical || !anchor || anchor.length < 2)
    throw new Error(`"${pattern}" would lock every file; lock a directory or file, like src/api/**`);
  return canonical;
}

function lockAnchor(pattern: string): { segments: string[]; glob: boolean } {
  const canonical = canonicalLockPattern(pattern);
  const parts = canonical.split("/");
  const firstGlob = parts.findIndex((segment) => GLOB_META.test(segment));
  return { segments: firstGlob === -1 ? parts : parts.slice(0, firstGlob), glob: firstGlob !== -1 };
}

const segmentPrefix = (a: string[], b: string[]) => a.length <= b.length && a.every((segment, i) => segment === b[i]);

/** Conservative glob overlap, with path-segment rather than string-prefix comparisons. */
function overlaps(a: string, b: string): boolean {
  let pa: ReturnType<typeof lockAnchor>;
  let pb: ReturnType<typeof lockAnchor>;
  try {
    pa = lockAnchor(a);
    pb = lockAnchor(b);
  } catch {
    // A legacy malformed lock must fail closed until its holder releases it.
    return true;
  }
  return segmentPrefix(pa.segments, pb.segments) || segmentPrefix(pb.segments, pa.segments);
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
  if (files.length > 100) throw new Error("lock at most 100 paths at once");
  files = files.map(canonicalLockPattern);
  task = guardShared(m, roomId, task.slice(0, 500), "claim");
  const conflicts = lockConflicts(m, files);
  if (conflicts.length) {
    const c = conflicts[0];
    // Someone in a room you can't see: say only that it's locked, not by whom or with which pattern.
    if (!canSee(m, c.claim.roomId)) throw new Error(`${c.file} is locked by a member of another room`);
    throw new Error(`${c.file} is locked by @${c.claim.by} (room ${c.claim.roomId}: "${c.claim.task}") via ${c.held}`);
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

function randomSlug(name: string): string {
  const base = slug(name).slice(0, 34).replace(/-$/, "");
  for (;;) {
    const id = `${base}-${randomUUID().slice(0, 4)}`;
    if (!rooms.has(id)) return id;
  }
}

function uniqueSlug(name: string, taken: Map<string, unknown>, reserved = new Set<string>()): string {
  const base = slug(name);
  let id = base;
  for (let i = 2; taken.has(id) || reserved.has(id); i++) id = `${base}-${i}`;
  return id;
}
