// Client for the hub's REST + SSE API (types mirror hub/src/store.ts).
// People are signed in by an httpOnly session cookie, so nothing secret lives in the page.
import { useEffect, useRef, useState } from "react";
import { SnapshotRefreshQueue } from "./refresh-queue";
import { t } from "./i18n";

export type MemberKind = "human" | "agent";
export type MessageKind = "note" | "contract_change" | "question" | "done";
export type Adapter = "channel" | "exec" | "inbox" | "a2a" | "dashboard";
export type Role = "owner" | "admin" | "member";

export interface Member {
  handle: string;
  name: string;
  kind: MemberKind;
  org: string;
  scopeRoomId: string | null; // null: every room
  adapter: Adapter;
  role?: Role | null;
  owner?: string | null; // agents: the person who added them
  email?: string | null; // only about yourself, or for admins
  online?: boolean;
  paused?: boolean;
  disabled?: boolean;
  twoFactor?: boolean;
  prefs?: Prefs; // only about yourself
  recoveryCodesLeft?: number;
}
export interface Prefs {
  language: "en" | "cs";
  theme: "system" | "light" | "dark";
  holdAllForeign: boolean;
  emailOnHold: boolean;
}
export const DEFAULT_PREFS: Prefs = {
  language: "en",
  theme: "system",
  holdAllForeign: false,
  emailOnHold: false,
};
export type Decision = "pending" | "released" | "rejected";
export interface Approval {
  decision: Decision;
  agents: string[];
  by?: string;
  at?: string;
}
export interface GateDecision {
  decision: Decision;
  by?: string;
  at?: string;
}
export type SafetyStatus = "delivered" | "held" | "released" | "rejected";
export interface Safety {
  status: SafetyStatus;
  flags: string[];
  redactions: string[];
  reviewedBy?: string;
  gate?: GateDecision;
  approvals?: Record<string, Approval>;
}
export interface RoomPolicy {
  approveContractChanges: boolean;
}
export interface AuditEvent {
  id: string;
  at: string;
  type: "held" | "released" | "rejected" | "redacted" | "paused" | "resumed" | "policy" | "room" | "member";
  roomId: string;
  actor: string;
  target?: string;
  detail: string;
}
export interface Message {
  id: string;
  roomId: string;
  from: string;
  fromKind: MemberKind;
  org: string;
  kind: MessageKind;
  text: string;
  mentions: string[];
  mentionsRoom: boolean;
  safety?: Safety;
  at: string;
  forYou?: boolean;
  delivered?: string[];
}
export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string;
  messages: Message[];
  policy?: RoomPolicy;
  createdBy?: string | null;
}
export interface HubConfig {
  dashboard: boolean;
  demo: boolean;
  needsSetup: boolean;
  setupToken: boolean;
  instanceName: string;
  email: boolean;
  privacyContact: string;
  retentionDays: number;
  version: string;
}
export interface ApproverKey {
  id: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}
export interface Invite {
  id: string;
  email: string | null;
  org: string | null;
  room: string | null;
  roomName: string | null;
  role: Role | null;
  invitedBy: string | null;
  createdAt: string;
  expiresAt: string;
  url?: string; // only right after creating it
  emailed?: boolean;
}
export interface Setup {
  cli: { claude: string; codex: string; cursor: string };
  claudeCode: { mcpJson: unknown; launch: string };
  codex: { mcp: string; wake: string };
  cursor: { mcpJson: unknown; wake: string };
  a2a: { card: string; auth: string };
}
export type NewAgent = Member & { token: string; setup: Setup };
export type User = Member & { agents: number };

/**
 * Where requests go. The dashboard talks to the hub; the demo (/demo) plugs in
 * a simulated hub that runs in the browser, so visitors never reach each other.
 */
export interface EventSourceLike {
  onopen: ((e: Event) => void) | null;
  onerror: ((e: Event) => void) | null;
  addEventListener(type: string, listener: (e: MessageEvent) => void): void;
  close(): void;
}
export interface Transport {
  /** Resolves with the response body, or rejects with an ApiError. */
  call(path: string, init: RequestInit): Promise<unknown>;
  events(): EventSourceLike;
}
let transport: Transport | null = null;
export const useTransport = (t: Transport) => {
  transport = t;
};

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (transport) return (await transport.call(path, init)) as T;
  const res = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...init.headers },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? `hub answered ${res.status}`, res.status);
  return body as T;
}

/** Older hubs and custom transports may omit preferences; keep the UI safe at the boundary. */
const normalizeMember = <T extends Member>(member: T): T => ({
  ...member,
  prefs: { ...DEFAULT_PREFS, ...member.prefs },
});
const memberCall = <T extends Member>(promise: Promise<T>) => promise.then(normalizeMember);
const memberListCall = <T extends Member>(promise: Promise<T[]>) => promise.then((members) => members.map(normalizeMember));

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export type ResetResult = Member | { ok: true; twoFactor: true; requiresLogin: true };

const send = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const enc = encodeURIComponent;

export const api = {
  config: () => call<HubConfig>("/api/config"),
  setup: (body: { name: string; org: string; email: string; password: string; room?: string; handle?: string; instanceName?: string; setupToken?: string }) =>
    memberCall(call<Member>("/api/setup", send("POST", body))),
  signIn: (email: string, password: string, code?: string) => memberCall(call<Member>("/api/auth/login", send("POST", { email, password, code }))),
  signOut: () => call<{ ok: true }>("/api/auth/logout", send("POST", {})),
  demoLogin: (handle: string) => memberCall(call<Member>("/api/login", send("POST", { handle }))),
  me: () => memberCall(call<Member>("/api/me")),
  updateMe: (name: string) => memberCall(call<Member>("/api/me", send("PUT", { name }))),
  changePassword: (current: string, password: string) => call<{ ok: true }>("/api/me/password", send("POST", { current, password })),
  setPrefs: (prefs: Partial<Prefs>) => memberCall(call<Member>("/api/me/prefs", send("PUT", prefs))),
  totpSetup: (password?: string) => call<{ secret: string; uri: string }>("/api/me/2fa/setup", send("POST", password ? { password } : {})),
  totpEnable: (code: string) => call<{ recoveryCodes: string[] }>("/api/me/2fa/enable", send("POST", { code })),
  totpDisable: (password: string, code: string) => memberCall(call<Member>("/api/me/2fa/disable", send("POST", { password, code }))),
  totpRegenerate: (password: string, code: string) =>
    call<{ recoveryCodes: string[] }>("/api/me/2fa/recovery-codes", send("POST", { password, code })),
  approverKeys: () => call<ApproverKey[]>("/api/me/approver-keys"),
  addApproverKey: (label: string) => call<{ id: string; key: string }>("/api/me/approver-keys", send("POST", { label })),
  removeApproverKey: (id: string) => call<{ ok: true }>(`/api/me/approver-keys/${enc(id)}`, send("DELETE")),
  exportMe: () => call<unknown>("/api/me/export"),
  deleteMe: (password: string, deleteMessages: boolean) => call<{ ok: true }>("/api/me", send("DELETE", { password, deleteMessages })),
  setInstance: (patch: { name?: string; retentionDays?: number; privacyContact?: string }) =>
    call<{ instanceName: string; retentionDays: number; privacyContact: string }>("/api/instance", send("PUT", patch)),

  joinInfo: (code: string) =>
    call<{ instanceName: string; org: string; room: string | null; role: Role; email: string | null; invitedBy: string | null; expiresAt: string }>(`/api/join/${enc(code)}`),
  join: (code: string, body: { name: string; email?: string; handle?: string; password: string }) =>
    memberCall(call<Member>(`/api/join/${enc(code)}`, send("POST", body))),
  resetInfo: (code: string) => call<{ instanceName: string; email: string; name: string; twoFactor: boolean }>(`/api/reset/${enc(code)}`),
  reset: (code: string, password: string) =>
    call<ResetResult>(`/api/reset/${enc(code)}`, send("POST", { password })).then((result) =>
      "requiresLogin" in result ? result : normalizeMember(result),
    ),

  users: () => memberListCall(call<User[]>("/api/users")),
  updateUser: (handle: string, patch: { role?: Role; room?: string | null; org?: string; name?: string }) =>
    memberCall(call<Member>(`/api/users/${enc(handle)}`, send("PUT", patch))),
  removeUser: (handle: string) => call<{ ok: true }>(`/api/users/${enc(handle)}`, send("DELETE")),
  resetLink: (handle: string) => call<{ url: string; emailed: boolean; expiresAt: string }>(`/api/users/${enc(handle)}/reset`, send("POST", {})),

  invites: () => call<Invite[]>("/api/invites"),
  invite: (body: { email?: string; org?: string; room?: string | null; role?: Role }) => call<Invite>("/api/invites", send("POST", { kind: "human", ...body })),
  revokeInvite: (id: string) => call<{ ok: true }>(`/api/invites/${enc(id)}`, send("DELETE")),

  agents: () => memberListCall(call<Member[]>("/api/agents")),
  addAgent: (body: { name: string; handle?: string; room: string; adapter: Adapter; org?: string }) =>
    memberCall(call<NewAgent>("/api/agents", send("POST", body))),
  rotateAgent: (handle: string) => memberCall(call<NewAgent>(`/api/agents/${enc(handle)}/token`, send("POST", {}))),
  updateAgent: (handle: string, patch: { name?: string; room?: string; adapter?: Adapter }) =>
    memberCall(call<Member>(`/api/agents/${enc(handle)}`, send("PUT", patch))),
  removeAgent: (handle: string) => call<{ ok: true }>(`/api/agents/${enc(handle)}`, send("DELETE")),

  members: () => memberListCall(call<Member[]>("/api/members")),
  roomMembers: (room: string) => memberListCall(call<Member[]>(`/api/members?room=${enc(room)}`)),
  rooms: () => call<Room[]>("/api/rooms"),
  createRoom: (parentId: string | null, name: string, context = "") => call<Room>("/api/rooms", send("POST", { parentId, name, context })),
  updateRoom: (room: string, patch: { name?: string; parentId?: string | null }) => call<Room>(`/api/rooms/${enc(room)}`, send("PUT", patch)),
  deleteRoom: (room: string) => call<{ deleted: string[] }>(`/api/rooms/${enc(room)}`, send("DELETE")),
  post: (room: string, kind: MessageKind, text: string) => call<Message>(`/api/rooms/${enc(room)}/messages`, send("POST", { kind, text })),
  message: (id: string) => call<Message>(`/api/messages/${enc(id)}`),
  setContext: (room: string, context: string) => call<Room>(`/api/rooms/${enc(room)}/context`, send("PUT", { context })),
  review: (messageId: string, decision: "release" | "reject", scope?: "gate" | "agents") =>
    call<Message>(`/api/messages/${enc(messageId)}/review`, send("POST", { decision, scope })),
  pause: (handle: string, paused: boolean) => memberCall(call<Member>(`/api/members/${enc(handle)}/pause`, send("POST", { paused }))),
  setPolicy: (room: string, policy: RoomPolicy) => call<RoomPolicy>(`/api/rooms/${enc(room)}/policy`, send("PUT", policy)),
  audit: () => call<AuditEvent[]>("/api/audit"),
  joinWaitlist: (body: { email: string; name?: string; company?: string; useCase?: string; website?: string }) =>
    call<{ ok: boolean; position: number; already?: boolean; confirmationSent?: boolean }>("/api/waitlist", send("POST", body)),
  waitlistCount: () => call<{ count: number }>("/api/waitlist/count"),
};

export type HubStatus = "loading" | "live" | "offline";

/**
 * Rooms and members for the current viewer, kept live over SSE. `who` is the
 * signed-in handle (null: demo overview); changing it reloads everything.
 * The hub never echoes a member's own messages, so posts are added from the POST response.
 */
export function useHub(who: string | null, enabled = true, onMe?: (member: Member | null) => void) {
  const [rooms, setRooms] = useState<Record<string, Room>>({});
  const [members, setMembers] = useState<Record<string, Member>>({});
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [status, setStatus] = useState<HubStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const pendingDeliveries = useRef(new Map<string, Set<string>>());

  const addMessage = (m: Message) =>
    setRooms((prev) => {
      const room = prev[m.roomId];
      if (!room || room.messages.some((x) => x.id === m.id)) return prev;
      const pending = pendingDeliveries.current.get(m.id);
      if (pending) pendingDeliveries.current.delete(m.id);
      const delivered = [...new Set([...(m.delivered ?? []), ...(pending ?? [])])];
      return { ...prev, [m.roomId]: { ...room, messages: [...room.messages, { ...m, delivered }] } };
    });

  /** Replace a message in place (safety status changed: released, rejected). */
  const updateMessage = (m: Message) =>
    setRooms((prev) => {
      const room = prev[m.roomId];
      if (!room) return prev;
      const exists = room.messages.some((x) => x.id === m.id);
      const messages = exists ? room.messages.map((x) => (x.id === m.id ? { ...x, ...m, delivered: m.delivered ?? x.delivered } : x)) : [...room.messages, m];
      return { ...prev, [m.roomId]: { ...room, messages } };
    });

  /** Merge a room (new, renamed, moved, new context or claims) without dropping its messages. */
  const upsertRoom = (r: Partial<Room> & { id: string }) =>
    setRooms((prev) => ({ ...prev, [r.id]: { ...prev[r.id], ...r, messages: prev[r.id]?.messages ?? r.messages ?? [] } as Room }));

  const removeRooms = (ids: string[]) =>
    setRooms((prev) => {
      const next = { ...prev };
      for (const id of ids) delete next[id];
      return next;
    });

  useEffect(() => {
    if (!enabled) return;
    let closed = false;
    let opened = false;
    setStatus("loading");
    setRooms({});
    setMembers({});
    setAudit([]);
    pendingDeliveries.current.clear();

    const replaceSnapshot = ([rs, ms]: [Room[], Member[]]) => {
      if (closed) return;
      setRooms(Object.fromEntries(rs.map((r) => [r.id, r])));
      setMembers(Object.fromEntries(ms.map((m) => [m.handle, normalizeMember(m)])));
      setError(null);
    };
    const refreshQueue = new SnapshotRefreshQueue(async ({ includeMe, includeAudit }) => {
        if (includeMe && who && onMe) {
          api.me().then(
            (member) => !closed && onMe(member),
            (error) => !closed && error instanceof ApiError && error.status === 401 && onMe(null),
          );
        }
        try {
          const [rs, ms, nextAudit] = await Promise.all([api.rooms(), api.members(), includeAudit ? api.audit() : Promise.resolve(null)]);
          replaceSnapshot([rs, ms]);
          if (!closed && nextAudit) setAudit(nextAudit);
        } catch (error) {
          if (!closed) {
            setStatus("offline");
            setError((error as Error).message);
          }
        }
    });
    const refreshSnapshot = (includeMe = false, includeAudit = false) => refreshQueue.request(includeMe, includeAudit);

    void refreshSnapshot(false, true);

    // If an SSE frame arrives while a REST snapshot is in flight, request one
    // more snapshot after it. Otherwise the older response could overwrite a
    // newer event that was already applied locally.
    const noteLiveEvent = () => {
      refreshQueue.noteEvent();
    };

    const es: EventSourceLike = transport ? transport.events() : new EventSource("/api/events");
    es.onopen = () => {
      if (closed) return;
      setStatus("live");
      if (opened && who) void refreshSnapshot(true);
      opened = true;
    };
    es.onerror = () => {
      if (closed) return;
      setStatus("offline");
      // A revoked session/token closes the stream before it can carry an
      // invalidation event. Re-check the current account so a removed member
      // returns to sign-in instead of remaining in a permanently offline UI.
      if (who) void refreshSnapshot(true);
    };
    es.addEventListener("message", (e) => {
      noteLiveEvent();
      addMessage(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("room", (e) => {
      noteLiveEvent();
      upsertRoom(JSON.parse((e as MessageEvent).data));
      if (who) void refreshSnapshot(true);
    });
    es.addEventListener("room_deleted", (e) => {
      noteLiveEvent();
      removeRooms([JSON.parse((e as MessageEvent).data).id]);
      if (who) void refreshSnapshot(true);
    });
    es.addEventListener("room_messages_deleted", () => {
      noteLiveEvent();
      void refreshSnapshot(false);
    });
    es.addEventListener("invalidate", () => {
      noteLiveEvent();
      void refreshSnapshot(true, true);
    });
    es.addEventListener("member", (e) => {
      noteLiveEvent();
      const m = normalizeMember(JSON.parse((e as MessageEvent).data) as Member);
      setMembers((prev) => {
        if (m.disabled) {
          const next = { ...prev };
          delete next[m.handle];
          return next;
        }
        return { ...prev, [m.handle]: { ...prev[m.handle], ...m } };
      });
      if (who) void refreshSnapshot(true);
    });
    es.addEventListener("message_update", (e) => {
      noteLiveEvent();
      updateMessage(JSON.parse((e as MessageEvent).data));
    });
    es.addEventListener("delivery", (e) => {
      noteLiveEvent();
      const d: { messageId: string; roomId: string; handle: string } = JSON.parse((e as MessageEvent).data);
      setRooms((prev) => {
        const room = prev[d.roomId];
        if (!room || !room.messages.some((x) => x.id === d.messageId)) {
          if (!pendingDeliveries.current.has(d.messageId) && pendingDeliveries.current.size >= 512) {
            const oldest = pendingDeliveries.current.keys().next().value;
            if (oldest) pendingDeliveries.current.delete(oldest);
          }
          const pending = pendingDeliveries.current.get(d.messageId) ?? new Set<string>();
          if (pending.size >= 128) return prev;
          pending.add(d.handle);
          pendingDeliveries.current.set(d.messageId, pending);
          return prev;
        }
        const messages = room.messages.map((x) =>
          x.id === d.messageId && !(x.delivered ?? []).includes(d.handle) ? { ...x, delivered: [...(x.delivered ?? []), d.handle] } : x,
        );
        return { ...prev, [d.roomId]: { ...room, messages } };
      });
    });
    es.addEventListener("presence", (e) => {
      noteLiveEvent();
      const p: { handle: string; online: boolean } = JSON.parse((e as MessageEvent).data);
      setMembers((prev) => (prev[p.handle] ? { ...prev, [p.handle]: { ...prev[p.handle], online: p.online } } : prev));
    });
    es.addEventListener("audit", (e) => {
      noteLiveEvent();
      const a: AuditEvent = JSON.parse((e as MessageEvent).data);
      setAudit((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
    });
    return () => {
      closed = true;
      es.close();
    };
  }, [who, enabled]);

  return { rooms, members, audit, status, error, addMessage, updateMessage, upsertRoom, removeRooms, setMembers };
}

/** The person who runs an agent. */
export function ownerOf(agent: Member, members: Record<string, Member>): Member | undefined {
  const owner = agent.owner ? members[agent.owner] : undefined;
  return owner?.kind === "human" ? owner : undefined;
}

/** "a / b / c": where a room sits in the tree. */
export function roomPath(id: string | null, rooms: Record<string, Room>): string {
  if (id === null) return t("every room");
  const names: string[] = [];
  for (let r: Room | undefined = rooms[id]; r; r = r.parentId ? rooms[r.parentId] : undefined) names.unshift(r.name);
  return names.join(" / ") || id;
}

/** Rooms in tree order with their depth, for pickers. */
export function roomOptions(rooms: Record<string, Room>): { room: Room; depth: number }[] {
  const children: Record<string, Room[]> = {};
  for (const r of Object.values(rooms)) (children[r.parentId && rooms[r.parentId] ? r.parentId : "root"] ??= []).push(r);
  const out: { room: Room; depth: number }[] = [];
  const walk = (parent: string, depth: number) => {
    for (const r of children[parent] ?? []) {
      out.push({ room: r, depth });
      walk(r.id, depth + 1);
    }
  };
  walk("root", 0);
  return out;
}
