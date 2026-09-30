// Dashboard: the room tree, one room's thread with a composer, and who is in the room.
// People sign in by picking who they are (demo login, see README limits).
import { StrictMode, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import { PaperPlaneRight, PencilSimple, Plus } from "@phosphor-icons/react";
import "./styles.css";
import { Logo } from "./Logo";
import { api, ownerOf, storedToken, storeToken, useHub, type Member, type Message, type MessageKind, type Room } from "./api";
import { Avatar, MessageItem } from "./ui";

function Dashboard() {
  const [token, setToken] = useState<string | null>(() => new URLSearchParams(location.search).get("token") ?? storedToken());
  const [me, setMe] = useState<Member | null>(null);
  const { rooms, members, status, error, addMessage, setRooms } = useHub(token);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    storeToken(token);
    if (!token) return void setMe(null);
    api.me(token).then(setMe, () => setToken(null));
  }, [token]);

  // Open where you're needed: a room that mentions you, else the latest activity, else the top room.
  // Re-picked when the viewer changes or the selection is no longer visible.
  useEffect(() => {
    if (selected && rooms[selected]) return;
    const all = Object.values(rooms);
    const handle = me?.handle;
    const mentioning = handle && all.find((r) => r.messages.some((m) => m.from !== handle && (m.forYou || m.mentions.includes(handle))));
    const latest = [...all].sort((a, b) => (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? ""))[0];
    const top = all.find((r) => !r.parentId || !rooms[r.parentId]);
    setSelected((mentioning || (latest?.messages.length ? latest : top))?.id ?? null);
  }, [rooms, selected, me]);

  const people = Object.values(members).filter((m) => m.kind === "human");
  const room = selected ? rooms[selected] : undefined;

  const signIn = async (handle: string) => {
    setSelected(null);
    if (!handle) return setToken(null);
    const m = await api.login(handle);
    setToken(m.token);
  };

  return (
    <div className="dash">
      <aside className="sidebar">
        <a href="/" className="sidebar-logo">
          <Logo />
        </a>
        <label className="viewer">
          <span>Viewing as</span>
          <select value={me?.handle ?? ""} onChange={(e) => signIn(e.target.value)}>
            <option value="">Everyone (read only)</option>
            {people.map((p) => (
              <option key={p.handle} value={p.handle}>
                {p.name} ({p.org})
              </option>
            ))}
          </select>
        </label>
        <nav aria-label="Rooms">
          <RoomTree rooms={rooms} selected={selected} onSelect={setSelected} me={me?.handle} />
        </nav>
        <p className={`hub-status ${status}`} role="status">
          {status === "live" ? "Connected to hub" : status === "loading" ? "Connecting to hub" : "Hub offline"}
        </p>
      </aside>

      <main className="room-main">
        {status === "offline" && Object.keys(rooms).length === 0 ? (
          <div className="empty">
            <h2>Can't reach the hub</h2>
            <p>
              Start it with <code>npm run dev</code> in the repo, then reload. {error && <span>({error})</span>}
            </p>
          </div>
        ) : room ? (
          <RoomView
            key={room.id}
            room={room}
            rooms={rooms}
            members={members}
            me={me}
            token={token}
            onPosted={addMessage}
            onContext={(r) => setRooms((prev) => ({ ...prev, [r.id]: { ...prev[r.id], context: r.context } }))}
            onNewRoom={(r) => {
              setRooms((prev) => ({ ...prev, [r.id]: r }));
              setSelected(r.id);
            }}
          />
        ) : (
          <div className="empty">
            <h2>{status === "loading" ? "Loading rooms" : "No rooms you can see"}</h2>
          </div>
        )}
      </main>
    </div>
  );
}

function RoomTree({
  rooms,
  selected,
  onSelect,
  me,
}: {
  rooms: Record<string, Room>;
  selected: string | null;
  onSelect: (id: string) => void;
  me?: string;
}) {
  const children = useMemo(() => {
    const map: Record<string, Room[]> = {};
    for (const r of Object.values(rooms)) {
      const parent = r.parentId && rooms[r.parentId] ? r.parentId : "root";
      (map[parent] ??= []).push(r);
    }
    return map;
  }, [rooms]);

  const render = (parent: string, depth: number) =>
    (children[parent] ?? []).map((r) => {
      const forMe = me ? r.messages.filter((m) => m.from !== me && (m.forYou || m.mentions.includes(me))).length : 0;
      return (
        <li key={r.id}>
          <button
            className={`room-link${selected === r.id ? " active" : ""}`}
            style={{ paddingLeft: 16 + depth * 16 }}
            aria-current={selected === r.id ? "page" : undefined}
            onClick={() => onSelect(r.id)}
          >
            <span className="room-glyph" aria-hidden />
            <span className="room-name">{r.name}</span>
            {forMe > 0 && (
              <span className="badge-mention" aria-label={`${forMe} mentions you`}>
                {forMe}
              </span>
            )}
          </button>
          {children[r.id] && <ul>{render(r.id, depth + 1)}</ul>}
        </li>
      );
    });

  return <ul className="room-tree">{render("root", 0)}</ul>;
}

function RoomView({
  room,
  rooms,
  members,
  me,
  token,
  onPosted,
  onContext,
  onNewRoom,
}: {
  room: Room;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  me: Member | null;
  token: string | null;
  onPosted: (m: Message) => void;
  onContext: (r: Room) => void;
  onNewRoom: (r: Room) => void;
}) {
  const [inRoom, setInRoom] = useState<Member[]>([]);
  const threadEnd = useRef<HTMLDivElement>(null);
  const memberCount = Object.keys(members).length;

  useEffect(() => {
    api.roomMembers(room.id).then(setInRoom, () => setInRoom([]));
  }, [room.id, memberCount]);

  useEffect(() => {
    threadEnd.current?.scrollIntoView({ block: "end" });
  }, [room.messages.length]);

  const path: Room[] = [];
  for (let r: Room | undefined = room; r; r = r.parentId ? rooms[r.parentId] : undefined) path.unshift(r);

  const addSubroom = async () => {
    const name = prompt(`Name of the new subroom under ${room.name}`);
    if (name?.trim() && token) onNewRoom(await api.createRoom(token, room.id, name.trim()));
  };

  return (
    <div className="room-view">
      <section className="thread-col">
        <header className="room-head">
          <h1>
            {path.map((r, i) => (
              <span key={r.id} className={i === path.length - 1 ? "crumb current" : "crumb"}>
                {r.name}
              </span>
            ))}
          </h1>
          {me && (
            <button className="ghost" onClick={addSubroom}>
              <Plus size={14} weight="bold" aria-hidden /> Subroom
            </button>
          )}
        </header>

        <RoomContext room={room} token={me ? token : null} onSaved={onContext} />

        {room.messages.length === 0 ? (
          <div className="empty thread-empty">
            <p>No messages yet. Type @ to hand work to an agent or a person in this room.</p>
          </div>
        ) : (
          <ol className="thread">
            {room.messages.map((m) => (
              <MessageItem key={m.id} m={m} author={members[m.from]} me={me?.handle} external={!!me && m.org !== me.org} />
            ))}
          </ol>
        )}
        <div ref={threadEnd} />

        <Composer room={room} me={me} token={token} inRoom={inRoom} onPosted={onPosted} />
      </section>

      <MembersPanel inRoom={inRoom} members={members} me={me} />
    </div>
  );
}

function RoomContext({ room, token, onSaved }: { room: Room; token: string | null; onSaved: (r: Room) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.context);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      onSaved(await api.setContext(token!, room.id, draft));
      setEditing(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <details className="context" open>
      <summary>
        Room context <span className="hint">what every agent here reads first</span>
      </summary>
      {editing ? (
        <div className="context-edit">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={6} aria-label="Room context (markdown)" />
          {error && <p className="error">{error}</p>}
          <div className="row">
            <button className="primary" onClick={save}>
              Save context
            </button>
            <button className="ghost" onClick={() => (setEditing(false), setDraft(room.context))}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <>
          <pre>{room.context || "No context yet."}</pre>
          {token && (
            <button className="ghost" onClick={() => (setDraft(room.context), setEditing(true))}>
              <PencilSimple size={14} weight="bold" aria-hidden /> Edit context
            </button>
          )}
        </>
      )}
    </details>
  );
}

const KINDS: { kind: MessageKind; label: string }[] = [
  { kind: "note", label: "Note" },
  { kind: "question", label: "Question" },
  { kind: "contract_change", label: "Contract change" },
  { kind: "done", label: "Done" },
];

function Composer({
  room,
  me,
  token,
  inRoom,
  onPosted,
}: {
  room: Room;
  me: Member | null;
  token: string | null;
  inRoom: Member[];
  onPosted: (m: Message) => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MessageKind>("note");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);

  // @autocomplete for the word being typed, when it starts with @.
  const query = /(?:^|\s)@([a-z0-9_-]*)$/i.exec(text)?.[1]?.toLowerCase();
  const everyone = { handle: "room", name: "Everyone in this room", kind: "human" } as Member;
  const suggestions =
    query === undefined
      ? []
      : [...inRoom.filter((m) => m.handle !== me?.handle), everyone]
          .filter((m) => m.handle.startsWith(query) || m.name.toLowerCase().startsWith(query))
          .slice(0, 6);

  const complete = (handle: string) => {
    setText((t) => t.replace(/@([a-z0-9_-]*)$/i, `@${handle} `));
    setPick(0);
    input.current?.focus();
  };

  const send = async () => {
    if (!token || !text.trim() || sending) return;
    setSending(true);
    try {
      onPosted(await api.post(token, room.id, kind, text.trim()));
      setText("");
      setKind("note");
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick((p) => (p + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        complete(suggestions[pick].handle);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!me)
    return (
      <p className="composer-signin">
        Pick who you are under <b>Viewing as</b> to post in {room.name}.
      </p>
    );

  return (
    <form className="composer" onSubmit={(e) => (e.preventDefault(), send())}>
      {suggestions.length > 0 && (
        <ul className="suggest" role="listbox" aria-label="Mention someone">
          {suggestions.map((m, i) => (
            <li key={m.handle} role="option" aria-selected={i === pick}>
              <button type="button" onMouseDown={(e) => (e.preventDefault(), complete(m.handle))}>
                {m.handle !== "room" && <Avatar kind={m.kind} name={m.name} size={22} />}
                <span className="msg-name">{m.name}</span>
                <span className="msg-handle">@{m.handle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        ref={input}
        value={text}
        onChange={(e) => (setText(e.target.value), setPick(0))}
        onKeyDown={onKey}
        rows={2}
        placeholder={`Message ${room.name}. Type @ to mention an agent or a person.`}
        aria-label={`Message ${room.name}`}
      />
      {error && <p className="error">{error}</p>}
      <div className="composer-bar">
        <div className="kinds" role="radiogroup" aria-label="Message type">
          {KINDS.map((k) => (
            <button
              key={k.kind}
              type="button"
              role="radio"
              aria-checked={kind === k.kind}
              className={`kind-pick kind-${k.kind}${kind === k.kind ? " on" : ""}`}
              onClick={() => setKind(k.kind)}
            >
              {k.label}
            </button>
          ))}
        </div>
        <button className="primary" type="submit" disabled={!text.trim() || sending}>
          <PaperPlaneRight size={15} weight="fill" aria-hidden /> Send
        </button>
      </div>
    </form>
  );
}

const DELIVERY: Record<Member["adapter"], string> = {
  channel: "pushed into its session",
  exec: "woken up on mention",
  inbox: "checks its inbox",
  a2a: "reached over A2A",
  dashboard: "in the dashboard",
};

function MembersPanel({ inRoom, members, me }: { inRoom: Member[]; members: Record<string, Member>; me: Member | null }) {
  // People first, each with their agents under them; agents whose person isn't in the room at the end.
  const humans = inRoom.filter((m) => m.kind === "human");
  const agentsOf = (h: Member) => inRoom.filter((a) => a.kind === "agent" && ownerOf(a, members)?.handle === h.handle);
  const orphans = inRoom.filter((a) => a.kind === "agent" && !humans.some((h) => ownerOf(a, members)?.handle === h.handle));
  const orgs = [...new Set(humans.map((h) => h.org))];

  return (
    <aside className="members" aria-label="Who is in this room">
      <h2>In this room</h2>
      {orgs.map((org) => (
        <section key={org}>
          <h3>
            {org}
            {me && org !== me.org && <span className="org">guest company</span>}
          </h3>
          <ul>
            {humans
              .filter((h) => h.org === org)
              .map((h) => (
                <li key={h.handle}>
                  <MemberRow m={h} me={me} />
                  {agentsOf(h).length > 0 && (
                    <ul className="agents">
                      {agentsOf(h).map((a) => (
                        <li key={a.handle}>
                          <MemberRow m={a} me={me} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
      {orphans.length > 0 && (
        <section>
          <h3>Other agents</h3>
          <ul>
            {orphans.map((a) => (
              <li key={a.handle}>
                <MemberRow m={a} me={me} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

function MemberRow({ m, me }: { m: Member; me: Member | null }) {
  return (
    <div className="member">
      <Avatar kind={m.kind} name={m.name} size={26} />
      <div>
        <div className="member-name">
          {m.name}
          {me?.handle === m.handle && <span className="you">you</span>}
        </div>
        <div className="member-sub">
          @{m.handle}
          {m.kind === "agent" && <>, {DELIVERY[m.adapter]}</>}
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
