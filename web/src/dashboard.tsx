// Dashboard (Operate mode): the room tree, one room's thread with a composer, and who is in the room.
// Built from shadcn primitives mapped onto the brand tokens (index.css). People sign in with their
// account (first run: owner setup); a demo hub lets you pick who you are. Design rules: web/DESIGN.md.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  ClockIcon,
  GearSixIcon,
  LockSimpleIcon,
  PaperPlaneRightIcon,
  PauseIcon,
  PencilSimpleIcon,
  PlayIcon,
  PlusIcon,
  ProhibitIcon,
  ShieldCheckIcon,
  ShieldWarningIcon,
  SignOutIcon,
  UserPlusIcon,
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
import { api, ownerOf, useHub, type AuditEvent, type HubConfig, type Member, type Message as Msg, type MessageKind, type Room } from "./api";
import { Avatar, KindTag, MentionText } from "./ui";
import { JoinScreen, ResetScreen, SetupScreen, SignInScreen } from "./account";
import { AgentDialog, InviteDialog, NewRoomDialog, RoomSettingsDialog } from "./dialogs";
import { Settings } from "./settings";
import { applyTheme, plural, savedTheme, setLanguage, t, useLanguage } from "./i18n";

const OVERVIEW = "__overview";
const SETTINGS = "__settings";

const isForMe = (m: Msg, handle: string) => m.from !== handle && (m.forYou || m.mentions.includes(handle) || m.mentionsRoom);
const isAdmin = (m: Member | null) => m?.role === "owner" || m?.role === "admin";

/** Decides what to show before the dashboard: a link being opened, first-run setup, or sign-in. */
export function App() {
  const params = new URLSearchParams(location.search);
  const [link, setLink] = useState(() => ({ invite: params.get("invite"), reset: params.get("reset") }));
  const [review] = useState(() => params.get("review"));
  useLanguage();
  useEffect(() => applyTheme(savedTheme()), []);
  const [config, setConfig] = useState<HubConfig | null>(null);
  const [me, setMe] = useState<Member | null | undefined>(undefined); // undefined while loading
  const [offline, setOffline] = useState<string | null>(null);

  useEffect(() => {
    api.config().then(setConfig, (e) => setOffline((e as Error).message));
    api.me().then(setMe, () => setMe(null));
  }, []);

  // Your saved settings follow you to every device.
  useEffect(() => {
    if (!me?.prefs) return;
    setLanguage(me.prefs.language);
    applyTheme(me.prefs.theme);
  }, [me?.prefs?.language, me?.prefs?.theme]);

  /** Signed in (or out): drop the one-time link from the address bar. */
  const enter = (m: Member | null) => {
    if (link.invite || link.reset) history.replaceState(null, "", review ? `/app?review=${review}` : "/app");
    setLink({ invite: null, reset: null });
    setConfig((c) => (c ? { ...c, needsSetup: false } : c));
    setMe(m);
  };

  if (offline)
    return (
      <Empty className="h-dvh">
        <EmptyHeader>
          <EmptyTitle>{t("The hub isn't answering")}</EmptyTitle>
          <EmptyDescription>
            {t("Start it with")} <Kbd>npm run dev</Kbd> {t("in the repo, then reload.")} ({offline})
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  if (!config || me === undefined) return null;
  if (link.invite) return <JoinScreen code={link.invite} onDone={enter} />;
  if (link.reset) return <ResetScreen code={link.reset} onDone={enter} />;
  if (config.needsSetup) return <SetupScreen config={config} onDone={enter} />;
  if (!me && !config.demo) return <SignInScreen config={config} onDone={enter} />;
  return <Dashboard config={config} me={me} onMe={enter} review={review} onConfig={(c) => setConfig((x) => (x ? { ...x, ...c } : x))} />;
}

function Dashboard({
  config,
  me,
  onMe,
  review,
  onConfig,
}: {
  config: HubConfig;
  me: Member | null;
  onMe: (m: Member | null) => void;
  review: string | null;
  onConfig: (c: Partial<HubConfig>) => void;
}) {
  const { rooms, members, audit, status, error, addMessage, updateMessage, upsertRoom, removeRooms } = useHub(me?.handle ?? null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newTop, setNewTop] = useState(false);
  const accounts = !config.demo;
  const canAddTop = !!me && isAdmin(me) && me.scopeRoomId === null;

  // A review link opens the room of that message.
  const [focus, setFocus] = useState<string | null>(review);
  useEffect(() => {
    if (!focus) return;
    const room = Object.values(rooms).find((r) => r.messages.some((x) => x.id === focus));
    if (room) setSelected(room.id);
  }, [rooms, focus]);

  // Open where you're needed: a room that mentions you, else the latest activity, else the top room.
  useEffect(() => {
    if (selected === SETTINGS || (selected && rooms[selected])) return;
    const all = Object.values(rooms);
    const handle = me?.handle;
    const mentioning = handle && all.find((r) => r.messages.some((m) => isForMe(m, handle)));
    const latest = [...all].sort((a, b) => (b.messages.at(-1)?.at ?? "").localeCompare(a.messages.at(-1)?.at ?? ""))[0];
    const top = all.find((r) => !r.parentId || !rooms[r.parentId]);
    setSelected((mentioning || (latest?.messages.length ? latest : top))?.id ?? null);
  }, [rooms, selected, me]);

  // Someone else changed your account (removed you, or your session ended): back to sign-in.
  useEffect(() => {
    if (me && status === "offline") api.me().catch(() => onMe(null));
  }, [status]);

  const people = Object.values(members).filter((m) => m.kind === "human");
  const room = selected && selected !== SETTINGS ? rooms[selected] : undefined;

  const pickPerson = async (handle: string) => {
    setSelected(null);
    if (handle === OVERVIEW) {
      await api.signOut();
      return onMe(null);
    }
    onMe(await api.demoLogin(handle));
  };
  const signOut = async () => {
    await api.signOut();
    onMe(null);
  };

  return (
    <TooltipProvider delayDuration={600}>
      <div className="grid h-dvh grid-cols-1 grid-rows-[auto_minmax(0,1fr)] md:grid-cols-[264px_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex max-h-[42dvh] min-h-0 flex-col gap-3 overflow-y-auto border-b border-border bg-card px-3 py-3 md:max-h-none md:gap-6 md:overflow-visible md:border-r md:border-b-0 md:py-5">
          <div className="flex flex-col gap-1 px-2">
            <a href="/app" className="no-underline">
              <Logo />
            </a>
            {accounts && <span className="truncate text-xs text-muted-foreground">{config.instanceName}</span>}
          </div>

          {!accounts && (
            <div className="flex flex-col gap-1.5 px-1">
              <span className="px-1 text-xs font-medium text-muted-foreground">{t("You are")}</span>
              <Select value={me?.handle ?? OVERVIEW} onValueChange={pickPerson}>
                <SelectTrigger className="w-full" aria-label={t("You are")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    <SelectLabel>{t("People")}</SelectLabel>
                    {people.map((p) => (
                      <SelectItem key={p.handle} value={p.handle}>
                        {p.name} <span className="text-muted-foreground">{p.org}</span>
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectItem value={OVERVIEW}>{t("Nobody, just looking")}</SelectItem>
                  </SelectGroup>
                </SelectContent>
              </Select>
            </div>
          )}

          <nav aria-label={t("Rooms")} className="min-h-0 md:flex-1 md:overflow-y-auto">
            <div className="mb-1 flex h-7 items-center justify-between pr-1 pl-3">
              <p className="m-0 text-xs font-medium text-muted-foreground">{t("Rooms")}</p>
              {canAddTop && (
                <Button variant="ghost" size="icon-xs" aria-label={t("New top-level room")} title={t("New top-level room")} onClick={() => setNewTop(true)}>
                  <PlusIcon weight="bold" />
                </Button>
              )}
            </div>
            <RoomTree rooms={rooms} selected={selected} onSelect={setSelected} me={me?.handle} />
          </nav>

          {me && accounts && (
            <div className="hidden flex-col gap-1 md:flex">
              <button
                onClick={() => (setSelected(SETTINGS), setFocus(null))}
                aria-current={selected === SETTINGS ? "page" : undefined}
                className={cn(
                  "flex h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-accent",
                  selected === SETTINGS && "bg-accent",
                )}
              >
                <Avatar kind="human" name={me.name} size={26} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{me.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{me.org}</span>
                </span>
                <GearSixIcon aria-hidden className="text-muted-foreground" />
              </button>
              <div className="flex items-center justify-between px-2">
                <p role="status" className={cn("m-0 text-xs text-muted-foreground", status === "offline" && "text-coral")}>
                  {status === "live" ? t("Live") : status === "loading" ? t("Connecting to the hub") : t("Hub offline")}
                </p>
                <Button variant="ghost" size="xs" onClick={signOut}>
                  <SignOutIcon data-icon="inline-start" />
                  {t("Sign out")}
                </Button>
              </div>
            </div>
          )}
          {me && accounts && (
            <div className="flex gap-2 px-1 md:hidden">
              <Button variant="ghost" size="sm" onClick={() => setSelected(SETTINGS)}>
                <GearSixIcon data-icon="inline-start" />
                {t("Settings")}
              </Button>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <SignOutIcon data-icon="inline-start" />
                {t("Sign out")}
              </Button>
            </div>
          )}
          {!accounts && (
            <p role="status" className={cn("hidden px-3 text-xs text-muted-foreground md:block", status === "offline" && "text-coral")}>
              {status === "live" ? t("Live") : status === "loading" ? t("Connecting to the hub") : t("Hub offline")}
            </p>
          )}
        </aside>

        <main className="min-h-0 min-w-0">
          {selected === SETTINGS && me ? (
            <Settings me={me} config={config} rooms={rooms} members={members} onMe={onMe} onConfig={onConfig} />
          ) : status === "offline" && Object.keys(rooms).length === 0 ? (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>{t("The hub isn't answering")}</EmptyTitle>
                <EmptyDescription>
                  {t("Start it with")} <Kbd>npm run dev</Kbd> {t("in the repo, then reload.")}{error && ` (${error})`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : room ? (
            <RoomView
              key={room.id}
              focus={focus}
              room={room}
              rooms={rooms}
              members={members}
              me={me}
              config={config}
              audit={audit}
              onPosted={addMessage}
              onUpdated={updateMessage}
              onContext={(r) => upsertRoom({ id: r.id, context: r.context })}
              onNewRoom={(r) => {
                upsertRoom(r);
                setSelected(r.id);
              }}
              onDeleted={(ids) => {
                removeRooms(ids);
                setSelected(room.parentId);
              }}
            />
          ) : (
            <Empty className="h-full">
              <EmptyHeader>
                <EmptyTitle>{status === "loading" ? t("Loading rooms") : canAddTop ? t("Start your tree") : t("No rooms you can see")}</EmptyTitle>
                {status !== "loading" && (
                  <EmptyDescription>
                    {canAddTop
                      ? "A top-level room is usually a product or a client. Rooms inside it are for tasks, and each one can have different people and agents."
                      : t("Ask whoever invited you to give you access to a room.")}
                  </EmptyDescription>
                )}
              </EmptyHeader>
              {canAddTop && status !== "loading" && (
                <Button onClick={() => setNewTop(true)}>
                  <PlusIcon data-icon="inline-start" weight="bold" />
                  {t("New room")}
                </Button>
              )}
            </Empty>
          )}
        </main>
      </div>
      <NewRoomDialog
        open={newTop}
        onOpenChange={setNewTop}
        parent={null}
        onCreated={(r) => {
          upsertRoom(r);
          setSelected(r.id);
        }}
      />
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
  config,
  audit,
  onPosted,
  onUpdated,
  onContext,
  onNewRoom,
  onDeleted,
  focus,
}: {
  focus?: string | null;
  room: Room;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  me: Member | null;
  config: HubConfig;
  audit: AuditEvent[];
  onPosted: (m: Msg) => void;
  onUpdated: (m: Msg) => void;
  onContext: (r: Room) => void;
  onNewRoom: (r: Room) => void;
  onDeleted: (ids: string[]) => void;
}) {
  const [inRoom, setInRoom] = useState<Member[]>([]);
  const [dialog, setDialog] = useState<"room" | "settings" | "invite" | "agent" | null>(null);
  const memberCount = Object.keys(members).length;
  const person = me?.kind === "human" ? me : null;

  // Refetch when someone joins, pauses or comes online, so the panel stays current.
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.paused ? 1 : 0}${m.online ? 1 : 0}${m.scopeRoomId}`)
    .join(",");
  useEffect(() => {
    api.roomMembers(room.id).then(setInRoom, () => setInRoom([]));
  }, [room.id, memberCount, memberState]);

  const path: Room[] = [];
  for (let r: Room | undefined = room; r; r = r.parentId ? rooms[r.parentId] : undefined) path.unshift(r);
  const open = (d: typeof dialog) => () => setDialog(d);
  const shut = (o: boolean) => !o && setDialog(null);

  return (
    <div className="grid h-full grid-cols-1 xl:grid-cols-[minmax(0,1fr)_288px]">
      <section className="flex min-h-0 min-w-0 flex-col">
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 pt-4 pb-2 md:px-8 md:pt-6 md:pb-3">
          <h1 className="flex min-w-0 basis-full flex-wrap items-baseline gap-x-2 font-heading text-xl sm:basis-auto md:text-2xl">
            {path.map((r, i) => (
              <span key={r.id} className={i === path.length - 1 ? "text-foreground" : "text-muted-foreground"}>
                {r.name}
                {i < path.length - 1 && <span className="ml-2 text-border">/</span>}
              </span>
            ))}
          </h1>
          <div className="-ml-2 flex min-w-0 flex-wrap items-center gap-x-1 md:ml-0 md:shrink-0">
            <PolicyToggle room={room} me={me} />
            {me && (
              <Button variant="ghost" size="sm" onClick={open("room")}>
                <PlusIcon data-icon="inline-start" weight="bold" />
                {t("New room inside")}
              </Button>
            )}
            {person && (
              <Button variant="ghost" size="sm" onClick={open("invite")}>
                <UserPlusIcon data-icon="inline-start" />
                {t("Invite")}
              </Button>
            )}
            {person && (person.scopeRoomId === null || person.scopeRoomId !== room.id) && (
              <Button variant="ghost" size="icon-sm" aria-label={t("{name} settings", { name: room.name })} title={t("Room settings")} onClick={open("settings")}>
                <GearSixIcon />
              </Button>
            )}
          </div>
        </header>

        <RoomContext room={room} canEdit={!!me} onSaved={onContext} />

        <Thread room={room} members={members} me={me} inRoom={inRoom} focus={focus} onUpdated={onUpdated} />

        <Composer room={room} me={me} inRoom={inRoom} onPosted={onPosted} />
      </section>

      <MembersPanel
        inRoom={inRoom}
        members={members}
        me={me}
        audit={audit.filter((a) => a.roomId === room.id)}
        onAddAgent={person ? open("agent") : undefined}
      />

      {me && <NewRoomDialog open={dialog === "room"} onOpenChange={shut} parent={room} onCreated={onNewRoom} />}
      {person && (
        <>
          <RoomSettingsDialog key={`${room.id}${room.name}${room.parentId}`} open={dialog === "settings"} onOpenChange={shut} room={room} rooms={rooms} me={person} onDeleted={onDeleted} />
          <InviteDialog open={dialog === "invite"} onOpenChange={shut} me={person} rooms={rooms} room={room.id} emailOn={config.email} />
          <AgentDialog open={dialog === "agent"} onOpenChange={shut} me={person} rooms={rooms} room={room.id} />
        </>
      )}
    </div>
  );
}

function RoomContext({ room, canEdit, onSaved }: { room: Room; canEdit: boolean; onSaved: (r: Room) => void }) {
  // On a phone the context starts folded so the thread gets the screen.
  const [open, setOpen] = useState(() => window.matchMedia("(min-width: 768px)").matches);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(room.context);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    try {
      onSaved(await api.setContext(room.id, draft));
      setEditing(false);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="px-4 pb-2 md:px-8">
      <div className="flex items-center gap-3">
        <CollapsibleTrigger asChild>
          <button className="text-sm font-medium text-muted-foreground hover:text-foreground">
            {open ? t("Hide room context") : t("Show room context")}
          </button>
        </CollapsibleTrigger>
        {open && canEdit && !editing && (
          <Button variant="ghost" size="sm" onClick={() => (setDraft(room.context), setEditing(true))}>
            <PencilSimpleIcon data-icon="inline-start" />
            {t("Edit")}
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
              aria-label={t("Room context, markdown")}
              className="font-mono text-[13px]"
            />
            {error && <p className="error">{error}</p>}
            <div className="flex gap-2">
              <Button size="sm" onClick={save}>
                {t("Save context")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setDraft(room.context))}>
                {t("Cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <pre className="mt-2 max-h-40 overflow-y-auto font-mono text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {room.context || t("No context yet. Write down what every agent in this room should know first.")}
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
  inRoom,
  focus,
  onUpdated,
}: {
  room: Room;
  members: Record<string, Member>;
  me: Member | null;
  inRoom: Member[];
  focus?: string | null;
  onUpdated: (m: Msg) => void;
}) {
  // Only messages that arrive while you're looking animate in; opening a room doesn't replay history.
  const [mountedAt] = useState(() => Date.now());
  // Opened from a review link (email, agent session): bring that message into view.
  useEffect(() => {
    if (focus) setTimeout(() => document.getElementById(`msg-${focus}`)?.scrollIntoView({ block: "center" }), 300);
  }, [focus]);
  if (room.messages.length === 0)
    return (
      <Empty className="flex-1">
        <EmptyHeader>
          <EmptyTitle>{t("Nothing here yet")}</EmptyTitle>
          <EmptyDescription>Type @ in the box below to hand work to an agent or a person in {room.name}.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <MessageScrollerProvider autoScroll>
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent className="flex flex-col gap-1 px-2 py-4 md:px-5">
            <MessageScrollerItem messageId="day">
              <Marker variant="separator" className="py-2">
                <MarkerContent>{t("Today")}</MarkerContent>
              </Marker>
            </MessageScrollerItem>
            {room.messages.map((m) => {
              const author = members[m.from];
              const forMe = !!me && isForMe(m, me.handle);
              const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              return (
                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.from === me?.handle}>
                  <Message
                    id={`msg-${m.id}`}
                    className={cn(
                      "items-start gap-3 rounded-xl px-3 py-2.5",
                      forMe && "bg-mention",
                      focus === m.id && "ring-2 ring-primary/60",
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
                      <SafetyLine m={m} me={me} members={members} onUpdated={onUpdated} />
                      <DeliveryLine m={m} inRoom={inRoom} />
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

const flagLabel = (f: string) =>
  ({
    "override-instructions": t("tries to override the agent's instructions"),
    "role-hijack": t("tries to change the agent's role"),
    "shell-payload": t("contains a shell payload"),
    exfiltration: t("asks for secrets"),
    destructive: t("asks for a destructive command"),
    "hidden-text": t("contains hidden characters"),
    "agent-loop": t("agents have been talking without a person"),
    strict: t("comes from another company and its recipient holds all of those"),
  })[f] ?? f;

const keyLabel = (key: string, members: Record<string, Member>) =>
  key.startsWith("org:") ? t("a person of {org}", { org: key.slice(4) }) : (members[key]?.name ?? "@" + key);

/** What the hub did to keep this message safe, who decides, and the buttons when it's you. */
function SafetyLine({ m, me, members, onUpdated }: { m: Msg; me: Member | null; members: Record<string, Member>; onUpdated: (m: Msg) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = m.safety;
  if (!s) return null;
  const approval = s.flags.includes("needs-approval");
  const reasons = s.flags.filter((f) => f !== "needs-approval").map(flagLabel);
  const person = me?.kind === "human" && me.handle !== m.from ? me : null;
  const mine = (key: string) => !!person && (key === person.handle || key === `org:${person.org}`);
  const gateIsMine = s.gate === "pending" && !!person && (!approval || person.org === m.org);
  const approvals = Object.entries(s.approvals ?? {});
  const myPending = approvals.filter(([k, a]) => a.decision === "pending" && mine(k));

  const decide = async (decision: "release" | "reject", scope: "gate" | "agents") => {
    setBusy(true);
    try {
      onUpdated(await api.review(m.id, decision, scope));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const buttons = (scope: "gate" | "agents", releaseLabel: string) => (
    <span className="ml-auto flex gap-2">
      <Button size="sm" disabled={busy} onClick={() => decide("release", scope)}>
        <ShieldCheckIcon data-icon="inline-start" />
        {releaseLabel}
      </Button>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide("reject", scope)}>
        <ProhibitIcon data-icon="inline-start" />
        {t("Reject")}
      </Button>
    </span>
  );

  return (
    <div className="mt-1.5 flex flex-col gap-1.5 text-[13px]">
      {s.redactions.length > 0 && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <LockSimpleIcon aria-hidden />
          {t("Secrets masked before anyone saw them ({kinds})", { kinds: s.redactions.join(", ") })}
        </span>
      )}

      {s.gate === "pending" && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-[10px] border border-dashed border-muted-foreground/50 px-3 py-2">
          <span className="flex items-center gap-1.5 font-semibold text-foreground">
            <ShieldWarningIcon aria-hidden weight="fill" />
            {approval ? t("Waiting for approval") : t("Held for review")}
          </span>
          <span className="text-muted-foreground">
            {approval
              ? t("Agents get this contract change once a person of {org} approves it.", { org: m.org })
              : t("No agent gets this until a person decides: {why}.", { why: reasons.join(", ") })}
          </span>
          {gateIsMine && buttons("gate", approval ? t("Approve") : t("Release"))}
        </div>
      )}

      {approvals.length > 0 && (
        <div className="flex flex-col gap-2 rounded-[10px] border border-dashed border-muted-foreground/50 px-3 py-2">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="flex items-center gap-1.5 font-semibold text-foreground">
              <ShieldWarningIcon aria-hidden weight="fill" />
              {s.status === "held" ? t("Held from agents") : t("Reviewed")}
            </span>
            <span className="text-muted-foreground">
              {t("From another company, and it {why}. Each owner decides for their own agents.", { why: reasons.join(", ") })}
            </span>
          </span>
          <ul className="flex flex-col gap-1">
            {approvals.map(([key, a]) => (
              <li key={key} className="flex flex-wrap items-center gap-x-2 text-muted-foreground">
                <span className={cn("font-medium", a.decision === "pending" ? "text-foreground" : "")}>
                  {a.agents.map((x) => "@" + x).join(", ")}
                </span>
                <span>
                  {a.decision === "pending"
                    ? mine(key)
                      ? t("wait for you")
                      : t("wait for {who}", { who: keyLabel(key, members) })
                    : a.decision === "released"
                      ? t("released by @{who}", { who: a.by ?? "" })
                      : t("rejected by @{who}: never saw it", { who: a.by ?? "" })}
                </span>
              </li>
            ))}
          </ul>
          {myPending.length > 0 && buttons("agents", t("Release to my agents"))}
        </div>
      )}
      {error && <p className="error w-full">{error}</p>}

      {!s.gate && !approvals.length && s.status === "delivered" && reasons.length > 0 && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldWarningIcon aria-hidden />
          {t("Flagged ({why}), delivered: no other company's agent is in this room", { why: reasons.join(", ") })}
        </span>
      )}
      {s.gate === "released" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheckIcon aria-hidden />
          {approval ? t("Approved by @{who}", { who: s.reviewedBy ?? "" }) : t("Released by @{who}", { who: s.reviewedBy ?? "" })}
        </span>
      )}
      {s.gate === "rejected" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ProhibitIcon aria-hidden />
          {t("Rejected by @{who}. No agent ever saw it.", { who: s.reviewedBy ?? "" })}
        </span>
      )}
    </div>
  );
}

/** Who a message reached: agents that got it, and the ones it waits for because they're offline. */
function DeliveryLine({ m, inRoom }: { m: Msg; inRoom: Member[] }) {
  if (m.safety?.status === "held" && m.safety.gate === "pending") return null;
  const targets = inRoom.filter((x) => x.kind === "agent" && x.handle !== m.from && (m.mentionsRoom || m.mentions.includes(x.handle)));
  if (!targets.length) return null;
  const got = new Set(m.delivered ?? []);
  const blocked = (a: Member) => {
    const ap = Object.values(m.safety?.approvals ?? {}).find((x) => x.agents.includes(a.handle));
    return ap && ap.decision !== "released";
  };
  const done = targets.filter((a) => got.has(a.handle));
  const waiting = targets.filter((a) => !got.has(a.handle) && !blocked(a) && !a.paused);
  if (!done.length && !waiting.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
      {done.length > 0 && (
        <span className="flex items-center gap-1">
          <CheckIcon aria-hidden />
          {t("Delivered to {who}", { who: done.map((a) => "@" + a.handle).join(", ") })}
        </span>
      )}
      {waiting.map((a) => (
        <span key={a.handle} className="flex items-center gap-1">
          <ClockIcon aria-hidden />
          {a.online
            ? t("Sending to @{who}", { who: a.handle })
            : a.adapter === "inbox"
              ? t("@{who} reads it at its next check-in", { who: a.handle })
              : t("@{who} is offline: gets it when it reconnects", { who: a.handle })}
        </span>
      ))}
    </span>
  );
}

/** Per-room rule: agents' contract changes wait for a person of their own company. */
function PolicyToggle({ room, me }: { room: Room; me: Member | null }) {
  const on = !!room.policy?.approveContractChanges;
  const canSet = !!me && me.kind === "human";
  const label = on ? t("Contract changes need approval") : t("Contract changes go out directly");
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
          onClick={() => api.setPolicy(room.id, { approveContractChanges: !on }).catch(() => {})}
        >
          {glyph}
          {label}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {on ? t("Click to let agents' contract changes go out directly") : t("Click to make agents' contract changes wait for a person of their company")}
      </TooltipContent>
    </Tooltip>
  );
}

const kinds = (): { kind: MessageKind; label: string }[] => [
  { kind: "note", label: t("Note") },
  { kind: "question", label: t("Question") },
  { kind: "contract_change", label: t("Contract change") },
  { kind: "done", label: t("Done") },
];

function Composer({
  room,
  me,
  inRoom,
  onPosted,
}: {
  room: Room;
  me: Member | null;
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
    if (!me || !text.trim() || sending) return;
    setSending(true);
    try {
      onPosted(await api.post(room.id, kind, text.trim()));
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
      <p className="m-0 px-4 pt-3 pb-4 md:px-8 md:pb-6 text-sm text-muted-foreground">
        {t("Pick yourself under")} <span className="font-medium text-foreground">{t("You are")}</span> {t("to write in {name}.", { name: room.name })}
      </p>
    );

  return (
    <form className="px-4 pt-2 pb-4 md:px-8 md:pb-6" onSubmit={(e) => (e.preventDefault(), send())}>
      <Popover open={open}>
        <PopoverAnchor asChild>
          <Textarea
            ref={input}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            rows={2}
            placeholder={t("Write to {name}. Type @ to mention someone.", { name: room.name })}
            aria-label={t("Message {name}", { name: room.name })}
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
              <CommandEmpty>{t("Nobody by that name here.")}</CommandEmpty>
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
          aria-label={t("What kind of message")}
        >
          {kinds().map((k) => (
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
          {sending ? t("Sending") : t("Send")}
        </Button>
      </div>
    </form>
  );
}

const delivery = (a: Member["adapter"]) =>
  ({
    channel: t("Messages are pushed into its running session"),
    exec: t("Woken in its own thread when mentioned"),
    inbox: t("Reads its inbox when it checks in"),
    a2a: t("Reached over A2A"),
    dashboard: t("Reads this dashboard"),
  })[a];

function MembersPanel({
  inRoom,
  members,
  me,
  audit,
  onAddAgent,
}: {
  inRoom: Member[];
  members: Record<string, Member>;
  me: Member | null;
  audit: AuditEvent[];
  onAddAgent?: () => void;
}) {
  // People first, each with their agents under them; agents whose person isn't in the room at the end.
  const humans = inRoom.filter((m) => m.kind === "human");
  const agentsOf = (h: Member) => inRoom.filter((a) => a.kind === "agent" && ownerOf(a, members)?.handle === h.handle);
  const orphans = inRoom.filter((a) => a.kind === "agent" && !humans.some((h) => ownerOf(a, members)?.handle === h.handle));
  const orgs = [...new Set(humans.map((h) => h.org))];

  return (
    <aside aria-label={t("Who is in this room")} className="hidden min-h-0 overflow-y-auto border-l border-border px-5 py-6 xl:block">
      <h2 className="mb-5 font-heading text-base">{t("In this room")}</h2>
      <div className="flex flex-col gap-6">
        {orgs.map((org) => (
          <section key={org} className="flex flex-col gap-3">
            <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">
              {org}
              {me && org !== me.org && ` (${t("guest company")})`}
            </h3>
            <ul className="flex flex-col gap-3">
              {humans
                .filter((h) => h.org === org)
                .map((h) => (
                  <li key={h.handle} className="flex flex-col gap-2">
                    <MemberRow m={h} me={me} />
                    {agentsOf(h).map((a) => (
                      <div key={a.handle} className="ml-3 border-l border-border pl-4">
                        <MemberRow m={a} me={me} />
                      </div>
                    ))}
                  </li>
                ))}
            </ul>
          </section>
        ))}
        {orphans.length > 0 && (
          <section className="flex flex-col gap-3">
            <h3 className="font-sans text-xs font-medium tracking-normal text-muted-foreground">{t("Other agents")}</h3>
            {orphans.map((a) => (
              <MemberRow key={a.handle} m={a} me={me} />
            ))}
          </section>
        )}
        {onAddAgent && (
          <Button variant="ghost" size="sm" className="self-start" onClick={onAddAgent}>
            <PlusIcon data-icon="inline-start" weight="bold" />
            {t("Add your agent here")}
          </Button>
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
        {t("Safety log")}
      </h3>
      <ol className="flex flex-col gap-2.5">
        {[...audit]
          .reverse()
          .slice(0, 8)
          .map((a) => (
            <li key={a.id} className="text-xs leading-snug">
              <span className="text-foreground">{a.detail}</span>
              <span className="block text-muted-foreground">
                {a.actor === "hub" ? t("automatic") : `@${a.actor}`} ·{" "}
                {new Date(a.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              </span>
            </li>
          ))}
      </ol>
    </section>
  );
}

function MemberRow({ m, me }: { m: Member; me: Member | null }) {
  // Stop button: a person can pause an agent of their own company.
  const canPause = m.kind === "agent" && !!me && me.kind === "human" && me.org === m.org;
  const row = (
    <div className={cn("flex items-center gap-3", m.paused && "opacity-60")}>
      <Avatar kind={m.kind} name={m.name} size={28} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-semibold">
          {m.name}
          {me?.handle === m.handle && <span className="ml-1.5 text-xs font-medium text-primary">{t("you")}</span>}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          @{m.handle}
          {m.paused ? ` · ${t("paused")}` : m.online ? ` · ${t("online")}` : ""}
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
        <TooltipContent side="left">{m.paused ? t("Paused by a person: it can't post and gets no messages") : delivery(m.adapter)}</TooltipContent>
      </Tooltip>
      {canPause && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={m.paused ? t("Resume {name}", { name: m.name }) : t("Pause {name}", { name: m.name })}
          title={m.paused ? t("Resume") : t("Pause")}
          onClick={() => api.pause(m.handle, !m.paused).catch(() => {})}
        >
          {m.paused ? <PlayIcon weight="fill" /> : <PauseIcon weight="fill" />}
        </Button>
      )}
    </div>
  );
}
