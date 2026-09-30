// Client for the hub's REST + SSE API. Contract: collab.md (types mirror hub/src/store.ts).
import { useEffect, useRef, useState } from "react";

export type MemberKind = "human" | "agent";
export type MessageKind = "note" | "contract_change" | "question" | "done";
export type Adapter = "channel" | "exec" | "inbox" | "a2a" | "dashboard";

export interface Member {
  handle: string;
  name: string;
  kind: MemberKind;
  org: string;
  scopeRoomId: string;
  adapter: Adapter;
  online?: boolean;
  paused?: boolean;
}
export type SafetyStatus = "delivered" | "held" | "released" | "rejected";
export interface Safety {
  status: SafetyStatus;
  flags: string[];
  redactions: string[];
  reviewedBy?: string;
}
export interface RoomPolicy {
  approveContractChanges: boolean;
}
export interface AuditEvent {
  id: string;
  at: string;
  type: "held" | "released" | "rejected" | "redacted" | "paused" | "resumed" | "policy";
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
}
export interface Room {
  id: string;
  parentId: string | null;
  name: string;
  context: string;
  messages: Message[];
  policy?: RoomPolicy;
}

const TOKEN_KEY = "warren.token";

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function storeToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: identity lasts for this tab only */
  }
}

async function call<T>(path: string, token: string | null, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `hub answered ${res.status}`);
  return body as T;
}

export const api = {
  login: (handle: string) => call<Member & { token: string }>("/api/login", null, { method: "POST", body: JSON.stringify({ handle }) }),
  me: (token: string) => call<Member>("/api/me", token),
  members: () => call<Member[]>("/api/members", null),
  roomMembers: (room: string) => call<Member[]>(`/api/members?room=${encodeURIComponent(room)}`, null),
  rooms: (token: string | null) => call<Room[]>("/api/rooms", token),
  post: (token: string, room: string, kind: MessageKind, text: string) =>
    call<Message>(`/api/rooms/${encodeURIComponent(room)}/messages`, token, { method: "POST", body: JSON.stringify({ kind, text }) }),
  setContext: (token: string, room: string, context: string) =>
    call<Room>(`/api/rooms/${encodeURIComponent(room)}/context`, token, { method: "PUT", body: JSON.stringify({ context }) }),
  createRoom: (token: string, parentId: string, name: string) =>
    call<Room>("/api/rooms", token, { method: "POST", body: JSON.stringify({ parentId, name }) }),
  review: (token: string, messageId: string, decision: "release" | "reject") =>
    call<Message>(`/api/messages/${encodeURIComponent(messageId)}/review`, token, { method: "POST", body: JSON.stringify({ decision }) }),
  pause: (token: string, handle: string, paused: boolean) =>
    call<Member>(`/api/members/${encodeURIComponent(handle)}/pause`, token, { method: "POST", body: JSON.stringify({ paused }) }),
  setPolicy: (token: string, room: string, policy: RoomPolicy) =>
    call<RoomPolicy>(`/api/rooms/${encodeURIComponent(room)}/policy`, token, { method: "PUT", body: JSON.stringify(policy) }),
  audit: (token: string | null) => call<AuditEvent[]>("/api/audit", token),
  joinWaitlist: (body: { email: string; name?: string; company?: string; useCase?: string; website?: string }) =>
    call<{ ok: boolean; position: number; already?: boolean }>("/api/waitlist", null, { method: "POST", body: JSON.stringify(body) }),
  waitlistCount: () => call<{ count: number }>("/api/waitlist/count", null),
};

export type HubStatus = "loading" | "live" | "offline";

/**
 * Rooms and members for the current viewer, kept live over SSE.
 * The hub never echoes a member's own messages, so posts are added from the POST response.
 */
export function useHub(token: string | null) {
  const [rooms, setRooms] = useState<Record<string, Room>>({});
  const [members, setMembers] = useState<Record<string, Member>>({});
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [status, setStatus] = useState<HubStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(token);
  tokenRef.current = token;

  const addMessage = (m: Message) =>
    setRooms((prev) => {
      const room = prev[m.roomId];
      if (!room || room.messages.some((x) => x.id === m.id)) return prev;
      return { ...prev, [m.roomId]: { ...room, messages: [...room.messages, m] } };
    });

  /** Replace a message in place (safety status changed: released, rejected). */
  const updateMessage = (m: Message) =>
    setRooms((prev) => {
      const room = prev[m.roomId];
      if (!room) return prev;
      const exists = room.messages.some((x) => x.id === m.id);
      const messages = exists ? room.messages.map((x) => (x.id === m.id ? { ...x, ...m } : x)) : [...room.messages, m];
      return { ...prev, [m.roomId]: { ...room, messages } };
    });

  useEffect(() => {
    let closed = false;
    setStatus("loading");
    api
      .audit(token)
      .then((a) => !closed && setAudit(a))
      .catch(() => {});
    Promise.all([api.rooms(token), api.members()])
      .then(([rs, ms]) => {
        if (closed) return;
        setRooms(Object.fromEntries(rs.map((r) => [r.id, r])));
        setMembers(Object.fromEntries(ms.map((m) => [m.handle, m])));
        setError(null);
      })
      .catch((e) => !closed && (setStatus("offline"), setError((e as Error).message)));

    const es = new EventSource(`/api/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    es.onopen = () => !closed && setStatus("live");
    es.onerror = () => !closed && setStatus("offline");
    es.addEventListener("message", (e) => addMessage(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("room", (e) => {
      const r: Room = JSON.parse((e as MessageEvent).data);
      setRooms((prev) => ({ ...prev, [r.id]: { ...r, messages: prev[r.id]?.messages ?? r.messages } }));
    });
    es.addEventListener("member", (e) => {
      const m: Member = JSON.parse((e as MessageEvent).data);
      setMembers((prev) => ({ ...prev, [m.handle]: { ...prev[m.handle], ...m } }));
    });
    es.addEventListener("message_update", (e) => updateMessage(JSON.parse((e as MessageEvent).data)));
    es.addEventListener("presence", (e) => {
      const p: { handle: string; online: boolean } = JSON.parse((e as MessageEvent).data);
      setMembers((prev) => (prev[p.handle] ? { ...prev, [p.handle]: { ...prev[p.handle], online: p.online } } : prev));
    });
    es.addEventListener("audit", (e) => {
      const a: AuditEvent = JSON.parse((e as MessageEvent).data);
      setAudit((prev) => (prev.some((x) => x.id === a.id) ? prev : [...prev, a]));
    });
    return () => {
      closed = true;
      es.close();
    };
  }, [token]);

  return { rooms, members, audit, status, error, addMessage, updateMessage, setMembers, setRooms };
}

/** The human who runs an agent, by handle suffix: claude-anna belongs to anna. */
export function ownerOf(agent: Member, members: Record<string, Member>): Member | undefined {
  const suffix = agent.handle.split("-").at(-1);
  const owner = suffix ? members[suffix] : undefined;
  return owner?.kind === "human" ? owner : undefined;
}
