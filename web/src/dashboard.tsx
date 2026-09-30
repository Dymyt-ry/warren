// Dashboard (Operate mode): the room tree, one room's thread with a composer, and who is in the room.
// Built from shadcn primitives mapped onto the brand tokens (index.css). People sign in by picking
// who they are (demo login, see README limits). Design rules: web/DESIGN.md.
import { StrictMode, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  LockSimpleIcon,
  PaperPlaneRightIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react";
import "@fontsource-variable/outfit";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import "./styles.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Kbd } from "@/components/ui/kbd";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Logo } from "./Logo";
import {
  api,
  ownerOf,
  storedToken,
  storeToken,
  useHub,
  type AuditEvent,
  type Member,
  type Message as Msg,
  type MessageKind,
  type Room,
} from "./api";
import { Avatar, KindTag, MentionText } from "./ui";

const OVERVIEW = "__overview";

const isForMe = (m: Msg, handle: string) => m.from !== handle && (m.forYou || m.mentions.includes(handle) || m.mentionsRoom);

function Dashboard() {
  const [token, setToken] = useState<string | null>(() => new URLSearchParams(location.search).get("token") ?? storedToken());
  const [me, setMe] = useState<Member | null>(null);
  const { rooms, members, audit, status, error, addMessage, updateMessage, setRooms } = useHub(token);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    storeToken(token);
    if (!token) return void setMe(null);
    api.me(token).then(setMe, () => setToken(null));
  }, [token]);

  // Open where you're needed: a room that mentions you, else the latest activity, else the top room.
  useEffect(() => {
    if (selected && rooms[selected]) return;
    const all = Object.values(rooms);
    const handle = me?.handle;
    const mentioning = handle && all.find((r) => r.messages.some((m) => isForMe(m, handle)));
    const latest = [...all].sort((a, b) => (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? ""))[0];
    const top = all.find((r) => !r.parentId || !rooms[r.parentId]);
    setSelected((mentioning || (latest?.messages.length ? latest : top))?.id ?? null);
  }, [rooms, selected, me]);

  const people = Object.values(members).filter((m) => m.kind === "human");
  const room = selected ? rooms[selected] : undefined;

  const signIn = async (handle: string) => {
    setSelected(null);
    if (handle === OVERVIEW) return setToken(null);
    const m = await api.login(handle);
    setToken(m.token);
  };

  return (
    <TooltipProvider delayDuration={600}>
      <div className="grid h-dvh grid-cols-1 md:grid-cols-[264px_minmax(0,1fr)]">
        <aside className="flex min-h-0 flex-col gap-6 border-border bg-card px-3 py-5 md:border-r">
          <a href="/" className="px-2 no-underline">
            <Logo />
          </a>

          <div className="flex flex-col gap-1.5 px-1">
            <span className="px-1 text-xs font-medium text-muted-foreground">You are</span>
            <Select value={me?.handle ?? OVERVIEW} onValueChange={signIn}>
              <SelectTrigger className="w-full" aria-label="You are">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>People</SelectLabel>
                  {people.map((p) => (
                    <SelectItem key={p.handle} value={p.handle}>
                      {p.name} <span className="text-muted-foreground">{p.org}</span>
                    </SelectItem>
                  ))}
                </SelectGroup>
                <SelectGroup>
                  <SelectItem value={OVERVIEW}>Nobody, just looking</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <nav aria-label="Rooms" className="min-h-0 flex-1 overflow-y-auto">
            <p className="mb-1 px-3 text-xs font-medium text-muted-foreground">Rooms</p>
            <RoomTree rooms={rooms} selected={selected} onSelect={setSelected} me={me?.handle} />
          </nav>

          <p role="status" className={cn("px-3 text-xs text-muted-foreground", status === "offline" && "text-coral")}>
            {status === "live" ? "Live" : status === "loading" ? "Connecting to the hub" : "Hub offline"}
          </p>
        </aside>

        <main className="min-h-0 min-w-0">
          {status === "offline" && Object.keys(rooms).length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>The hub isn't answering</EmptyTitle>
                <EmptyDescription>
                  Start it with <Kbd>npm run dev</Kbd> in the repo, then reload.{error && ` (${error})`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : room ? (
            <RoomView
              key={room.id}
              room={room}
              rooms={rooms}
              members={members}
              me={me}
              token={token}
              audit={audit}
              onPosted={addMessage}
              onUpdated={updateMessage}
              onContext={(r) => setRooms((prev) => ({ ...prev, [r.id]: { ...prev[r.id], context: r.context } }))}
              onNewRoom={(r) => {
                setRooms((prev) => ({ ...prev, [r.id]: r }));
                setSelected(r.id);
              }}
            />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>{status === "loading" ? "Loading rooms" : "No rooms you can see"}</EmptyTitle>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
    </TooltipProvider>
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
      const forMe = me ? r.messages.filter((m) => isForMe(m, me)).length : 0;
      const active = selected === r.id;
      return (
        <li key={r.id}>
          <button
            onClick={() => onSelect(r.id)}
            aria-current={active ? "page" : undefined}
            style={{ paddingLeft: 12 + depth * 18 }}
            className={cn(
              "flex h-9 w-full items-center gap-2.5 rounded-lg pr-2 text-left text-sm transition-colors hover:bg-accent",
              active && "bg-accent font-semibold",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-3 shrink-0 rounded-[30%] border-[1.5px]",
                forMe ? "border-sun bg-sun" : active ? "border-primary" : "border-muted-foreground/60",
              )}
            />
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            {forMe > 0 && (
              <span className="text-xs font-semibold tabular-nums" aria-label={`${forMe} for you`}>
                {forMe}
              </span>
            )}
          </button>
          {children[r.id] && <ul>{render(r.id, depth + 1)}</ul>}
        </li>
      );
    });

  return <ul className="flex flex-col gap-0.5">{render("root", 0)}</ul>;
}

function RoomView({
  room,
  rooms,
  members,
  me,
  token,
  audit,
  onPosted,
  onUpdated,
  onContext,
  onNewRoom,
}: {
  room: Room;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  me: Member | null;
  token: string | null;
  audit: AuditEvent[];
  onPosted: (m: Msg) => void;
  onUpdated: (m: Msg) => void;
  onContext: (r: Room) => void;
  onNewRoom: (r: Room) => void;
}) {
  const [inRoom, setInRoom] = useState<Member[]>([]);
  const memberCount = Object.keys(members).length;

  // Refetch when someone joins, pauses or comes online, so the panel stays current.
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.paused ? 1 : 0}${m.online ? 1 : 0}`)
    .join(",");
  useEffect(() => {
    api.roomMembers(room.id).then(setInRoom, () => setInRoom([]));
  }, [room.id, memberCount, memberState]);

  const path: Room[] = [];
  for (let r: Room | undefined = room; r; r = r.parentId ? rooms[r.parentId] : undefined) path.unshift(r);

  const addSubroom = async () => {
    const name = prompt(`Name the new room inside ${room.name}`);
    if (name?.trim() && token) onNewRoom(await api.createRoom(token, room.id, name.trim()));
  };

  return (
    <div className="grid h-full grid-cols-1 xl:grid-cols-[minmax(0,1fr)_288px]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex items-center justify-between gap-4 px-8 pt-6 pb-3">
          <h1 className="flex min-w-0 flex-wrap items-baseline gap-x-2 font-heading text-2xl">
            {path.map((r, i) => (
              <span key={r.id} className={i === path.length - 1 ? "text-foreground" : "text-muted-foreground"}>
                {r.name}
                {i < path.length - 1 && <span className="ml-2 text-border">/</span>}
              </span>
            ))}
          </h1>
          <div className="flex shrink-0 items-center gap-1">
            <PolicyToggle room={room} me={me} token={token} />
            {me && (
              <Button variant="ghost" size="sm" onClick={addSubroom}>
                <PlusIcon data-icon="inline-start" weight="bold" />
                New room inside
              </Button>
            )}
          </div>
        </header>

        <RoomContext room={room} token={me ? token : null} onSaved={onContext} />

        <Thread room={room} members={members} me={me} token={token} onUpdated={onUpdated} />

        <Composer room={room} me={me} token={token} inRoom={inRoom} onPosted={onPosted} />
      </section>

      <MembersPanel inRoom={inRoom} members={members} me={me} token={token} audit={audit.filter((a) => a.roomId === room.id)} />
    </div>
  );
}

function RoomContext({ room, token, onSaved }: { room: Room; token: string | null; onSaved: (r: Room) => void }) {
  const [open, setOpen] = useState(true);
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
    <Collapsible open={open} onOpenChange={setOpen} className="px-8 pb-2">
      <div className="flex items-center gap-3">
        <CollapsibleTrigger asChild>
          <button className="text-sm font-medium text-muted-foreground hover:text-foreground">
            {open ? "Hide" : "Show"} room context
          </button>
        </CollapsibleTrigger>
        {open && token && !editing && (
          <Button variant="ghost" size="sm" onClick={() => (setDraft(room.context), setEditing(true))}>
            <PencilSimpleIcon data-icon="inline-start" />
            Edit
          </Button>
        )}
      </div>
      <CollapsibleContent>
        {editing ? (
          <div className="mt-2 flex flex-col gap-2">
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={6}
              aria-label="Room context, markdown"
              className="font-mono text-[13px]"
            />
            {error && <p className="error">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={save}>
                Save context
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft(room.context))}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <pre className="mt-2 max-h-40 overflow-y-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {room.context || "No context yet. Write down what every agent in this room should know first."}
          </pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function Thread({
  room,
  members,
  me,
  token,
  onUpdated,
}: {
  room: Room;
  members: Record<string, Member>;
  me: Member | null;
  token: string | null;
  onUpdated: (m: Msg) => void;
}) {
  // Only messages that arrive while you're looking animate in; opening a room doesn't replay history.
  const [mountedAt] = useState(() => Date.now());
  if (room.messages.length === 0)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>Nothing here yet</EmptyTitle>
          <EmptyDescription>Type @ in the box below to hand work to an agent or a person in {room.name}.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="flex flex-col gap-1 px-5 py-4">
            <MessageScrollerItem messageId="day">
              <Marker variant="separator" className="py-2">
                <MarkerContent>Today</MarkerContent>
              </Marker>
            </MessageScrollerItem>
            {room.messages.map((m) => {
              const author = members[m.from];
              const forMe = !!me && isForMe(m, me.handle);
              const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              return (
                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.from === me?.handle}>
                  <Message
                    className={cn(
                      "items-start gap-3 rounded-xl px-3 py-2.5",
                      forMe && "bg-mention",
                      Date.parse(m.at) > mountedAt && "msg-arrive",
                    )}
                  >
                    <MessageAvatar className="self-start overflow-visible rounded-none bg-transparent">
                      <Avatar kind={m.fromKind} name={author?.name ?? m.from} size={32} />
                    </MessageAvatar>
                    <MessageContent className="gap-1">
                      <MessageHeader className="gap-2.5 px-0 text-[13px]">
                        <span className="font-semibold text-foreground">{author?.name ?? m.from}</span>
                        {me && m.org !== me.org && <span>{m.org}</span>}
                        <KindTag kind={m.kind} />
                        <time className="ml-auto tabular-nums" dateTime={m.at}>
                          {time}
                        </time>
                      </MessageHeader>
                      <p
                        className={cn(
                          "m-0 text-[15px] leading-normal whitespace-pre-wrap text-foreground",
                          m.safety?.status === "rejected" && "text-muted-foreground line-through",
                        )}
                      >
                        <MentionText text={m.text} me={me?.handle} />
                      </p>
                      <SafetyLine m={m} me={me} token={token} onUpdated={onUpdated} />
                    </MessageContent>
                  </Message>
                </MessageScrollerItem>
              );
            })}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

const FLAG_LABEL: Record<string, string> = {
  "override-instructions": "tries to override the agent's instructions",
  "role-hijack": "tries to change the agent's role",
  "shell-payload": "contains a shell payload",
  exfiltration: "asks for secrets",
  destructive: "asks for a destructive command",
  "hidden-text": "contains hidden characters",
  "agent-loop": "agents have been talking without a person",
};

/** What the hub did to keep this message safe, and the review buttons when a person has to decide. */
function SafetyLine({
  m,
  me,
  token,
  onUpdated,
}: {
  m: Msg;
  me: Member | null;
  token: string | null;
  onUpdated: (m: Msg) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = m.safety;
  if (!s) return null;
  const approval = s.flags.includes("needs-approval");
  const reasons = s.flags.filter((f) => f !== "needs-approval").map((f) => FLAG_LABEL[f] ?? f);
  const suspicious = reasons.length > 0 && !s.flags.includes("agent-loop");
  // Approvals belong to the sender's company; suspected attacks to the people they target.
  const canReview =
    s.status === "held" &&
    !!me &&
    !!token &&
    me.kind === "human" &&
    me.handle !== m.from &&
    (approval ? me.org === m.org : !suspicious || me.org !== m.org);

  const decide = async (decision: "release" | "reject") => {
    setBusy(true);
    try {
      onUpdated(await api.review(token!, m.id, decision));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
      {s.redactions.length > 0 && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <LockSimpleIcon aria-hidden />
          Secrets masked before anyone saw them ({s.redactions.join(", ")})
        </span>
      )}
      {s.status === "held" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-dashed border-muted-foreground/50 px-3 py-2">
          <span className="flex items-center gap-1.5 font-semibold text-foreground">
            <ShieldWarningIcon aria-hidden weight="fill" />
            {approval ? "Waiting for approval" : "Held for review"}
          </span>
          <span className="text-muted-foreground">
            {approval
              ? `Agents get this contract change once a person of ${m.org} approves it.`
              : `No agent gets this until ${suspicious ? "a person outside " + m.org : "a person"} decides: ${reasons.join(", ")}.`}
          </span>
          {canReview && (
            <span className="ml-auto flex gap-2">
              <Button size="sm" disabled={busy} onClick={() => decide("release")}>
                <ShieldCheckIcon data-icon="inline-start" />
                {approval ? "Approve" : "Release"}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("reject")}>
                <ProhibitIcon data-icon="inline-start" />
                Reject
              </Button>
            </span>
          )}
          {error && <p className="error w-full">{error}</p>}
        </div>
      )}
      {s.status === "released" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheckIcon aria-hidden />
          {approval ? "Approved" : "Released"} by @{s.reviewedBy}
        </span>
      )}
      {s.status === "rejected" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ProhibitIcon aria-hidden />
          Rejected by @{s.reviewedBy}. No agent ever saw it.
        </span>
      )}
      {s.status === "delivered" && reasons.length > 0 && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldWarningIcon aria-hidden />
          Flagged ({reasons.join(", ")}), delivered because everyone here is from {m.org}
        </span>
      )}
    </div>
  );
}

/** Per-room rule: agents' contract changes wait for a person of their own company. */
function PolicyToggle({ room, me, token }: { room: Room; me: Member | null; token: string | null }) {
  const on = !!room.policy?.approveContractChanges;
  const canSet = !!me && me.kind === "human" && !!token;
  const label = on ? "Contract changes need approval" : "Contract changes go out directly";
  const glyph = <span aria-hidden className={cn("size-2.5 rounded-[30%] border-[1.5px] border-foreground", on && "bg-foreground")} />;
  if (!canSet)
    return <span className="flex items-center gap-2 px-2 text-xs text-muted-foreground">{glyph}{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-pressed={on}
          onClick={() => api.setPolicy(token!, room.id, { approveContractChanges: !on }).catch(() => {})}
        >
          {glyph}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {on ? "Click to let agents' contract changes go out directly" : "Click to make agents' contract changes wait for a person of their company"}
      </TooltipContent>
    </Tooltip>
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
  onPosted: (m: Msg) => void;
}) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState<MessageKind>("note");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [pick, setPick] = useState("");
  const [dismissed, setDismissed] = useState<string | null>(null);
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
  const open = suggestions.length > 0 && dismissed !== text;
  const active = suggestions.some((s) => s.handle === pick) ? pick : suggestions[0]?.handle ?? "";

  const complete = (handle: string) => {
    setText((t) => t.replace(/@([a-z0-9_-]*)$/i, `@${handle} `));
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
    if (open) {
      const i = suggestions.findIndex((s) => s.handle === active);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick(suggestions[(i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length].handle);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        complete(active);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(text);
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
      <p className="m-0 px-8 pt-3 pb-6 text-sm text-muted-foreground">
        Pick yourself under <span className="font-medium text-foreground">You are</span> to write in {room.name}.
      </p>
    );

  return (
    <form className="px-8 pt-2 pb-6" onSubmit={(e) => (e.preventDefault(), send())}>
      <Popover open={open}>
        <PopoverAnchor asChild>
          <Textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder={`Write to ${room.name}. Type @ to mention someone.`}
            aria-label={`Message ${room.name}`}
            aria-autocomplete="list"
            className="min-h-16 resize-none text-[15px]"
          />
        </PopoverAnchor>
        <PopoverContent
          side="top"
          align="start"
          className="w-72 p-1 data-open:animate-none data-closed:animate-none"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
        >
          <Command value={active} onValueChange={setPick} shouldFilter={false}>
            <CommandList>
              <CommandEmpty>Nobody by that name here.</CommandEmpty>
              <CommandGroup heading={`In ${room.name}`}>
                {suggestions.map((m) => (
                  <CommandItem key={m.handle} value={m.handle} onSelect={complete} className="gap-2.5">
                    {m.handle !== "room" && <Avatar kind={m.kind} name={m.name} size={22} />}
                    <span className="font-medium">{m.name}</span>
                    <span className="ml-auto text-xs text-muted-foreground">@{m.handle}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {error && <p className="error">{error}</p>}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
        <ToggleGroup
          type="single"
          size="sm"
          value={kind}
          onValueChange={(v) => v && setKind(v as MessageKind)}
          aria-label="What kind of message"
        >
          {KINDS.map((k) => (
            <ToggleGroupItem
              key={k.kind}
              value={k.kind}
              className={cn(k.kind === "contract_change" && "data-[state=on]:text-coral")}
            >
              {k.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Button type="submit" disabled={!text.trim() || sending}>
          <PaperPlaneRightIcon data-icon="inline-start" weight="fill" />
          {sending ? "Sending" : "Send"}
        </Button>
      </div>
    </form>
  );
}

const DELIVERY: Record<Member["adapter"], string> = {
  channel: "Messages are pushed into its running session",
  exec: "Woken in its own thread when mentioned",
  inbox: "Reads its inbox when it checks in",
  a2a: "Reached over A2A",
  dashboard: "Reads this dashboard",
};

function MembersPanel({
  inRoom,
  members,
  me,
  token,
  audit,
}: {
  inRoom: Member[];
  members: Record<string, Member>;
  me: Member | null;
  token: string | null;
  audit: AuditEvent[];
}) {
  // People first, each with their agents under them; agents whose person isn't in the room at the end.
  const humans = inRoom.filter((m) => m.kind === "human");
  const agentsOf = (h: Member) => inRoom.filter((a) => a.kind === "agent" && ownerOf(a, members)?.handle === h.handle);
  const orphans = inRoom.filter((a) => a.kind === "agent" && !humans.some((h) => ownerOf(a, members)?.handle === h.handle));
  const orgs = [...new Set(humans.map((h) => h.org))];

  return (
    <aside aria-label="Who is in this room" className="hidden min-h-0 overflow-y-auto border-l border-border px-5 py-6 xl:block">
      <h2 className="mb-5 font-heading text-base">In this room</h2>
      <div className="flex flex-col gap-6">
        {orgs.map((org) => (
          <section key={org} className="flex flex-col gap-3">
            <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">
              {org}
              {me && org !== me.org && " (guest company)"}
            </h3>
            <ul className="flex flex-col gap-3">
              {humans
                .filter((h) => h.org === org)
                .map((h) => (
                  <li key={h.handle} className="flex flex-col gap-2">
                    <MemberRow m={h} me={me} token={token} />
                    {agentsOf(h).map((a) => (
                      <div key={a.handle} className="ml-3 border-l border-border pl-4">
                        <MemberRow m={a} me={me} token={token} />
                      </div>
                    ))}
                  </li>
                ))}
            </ul>
          </section>
        ))}
        {orphans.length > 0 && (
          <section className="flex flex-col gap-3">
            <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">Other agents</h3>
            {orphans.map((a) => (
              <MemberRow key={a.handle} m={a} me={me} token={token} />
            ))}
          </section>
        )}
        <SafetyLog audit={audit} />
      </div>
    </aside>
  );
}

/** The room's audit trail: what the hub held, masked or paused, and who decided. */
function SafetyLog({ audit }: { audit: AuditEvent[] }) {
  if (audit.length === 0) return null;
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 font-sans text-xs font-medium tracking-normal text-muted-foreground">
        <ShieldCheckIcon aria-hidden />
        Safety log
      </h3>
      <ol className="flex flex-col gap-2.5">
        {[...audit]
          .reverse()
          .slice(0, 8)
          .map((a) => (
            <li key={a.id} className="text-xs leading-snug">
              <span className="text-foreground">{a.detail}</span>
              <span className="block text-muted-foreground">
                {a.actor === "hub" ? "automatic" : `@${a.actor}`} ·{" "}
                {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
      </ol>
    </section>
  );
}

function MemberRow({ m, me, token }: { m: Member; me: Member | null; token: string | null }) {
  // Stop button: a person can pause an agent of their own company.
  const canPause = m.kind === "agent" && !!me && !!token && me.kind === "human" && me.org === m.org;
  const row = (
    <div className={cn("flex items-center gap-3", m.paused && "opacity-60")}>
      <Avatar kind={m.kind} name={m.name} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {m.name}
          {me?.handle === m.handle && <span className="ml-1.5 text-xs font-medium text-primary">you</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          @{m.handle}
          {m.paused ? " · paused" : m.online ? " · online" : ""}
        </div>
      </div>
    </div>
  );
  if (m.kind !== "agent") return row;
  return (
    <div className="flex items-center gap-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <div tabIndex={0} className="min-w-0 flex-1 rounded-md">
            {row}
          </div>
        </TooltipTrigger>
        <TooltipContent side="left">{m.paused ? "Paused by a person: it can't post and gets no messages" : DELIVERY[m.adapter]}</TooltipContent>
      </Tooltip>
      {canPause && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.paused ? `Resume ${m.name}` : `Pause ${m.name}`}
          title={m.paused ? "Resume" : "Pause"}
          onClick={() => api.pause(token!, m.handle, !m.paused).catch(() => {})}
        >
          {m.paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
        </Button>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
