// Dashboard (Operate mode): the room tree, one room's thread with a composer, and who is in the room.
// Built from shadcn primitives mapped onto the brand tokens (index.css). People sign in with their
// account (first run: owner setup); a demo hub lets you pick who you are. Design rules: web/DESIGN.md.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CheckIcon,
  ClockIcon,
  DotsThreeIcon,
  GearSixIcon,
  HashIcon,
  InfoIcon,
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
  UsersIcon,
  UserPlusIcon,
  XIcon,
} from "@phosphor-icons/react";
import "@fontsource-variable/outfit";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import "./styles.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
const INITIAL_LINKS = (() => {
  const params = new URLSearchParams(location.search);
  const links = { invite: params.get("invite"), reset: params.get("reset"), review: params.get("review") };
  if (links.invite || links.reset) history.replaceState(history.state, "", "/app");
  return links;
})();

const isForMe = (m: Msg, handle: string) => m.from !== handle && (m.forYou || m.mentions.includes(handle) || m.mentionsRoom);
const isAdmin = (m: Member | null) => m?.role === "owner" || m?.role === "admin";

/** Decides what to show before the dashboard: a link being opened, first-run setup, or sign-in. */
export function App() {
  const [link, setLink] = useState(() => ({ invite: INITIAL_LINKS.invite, reset: INITIAL_LINKS.reset }));
  const [review, setReview] = useState(INITIAL_LINKS.review);
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
  return (
    <Dashboard
      config={config}
      me={me}
      onMe={enter}
      review={review}
      onReviewConsumed={() => {
        setReview(null);
        const url = new URL(location.href);
        url.searchParams.delete("review");
        history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }}
      onConfig={(c) => setConfig((x) => (x ? { ...x, ...c } : x))}
    />
  );
}

function Dashboard({
  config,
  me,
  onMe,
  review,
  onReviewConsumed,
  onConfig,
}: {
  config: HubConfig;
  me: Member | null;
  onMe: (m: Member | null) => void;
  review: string | null;
  onReviewConsumed: () => void;
  onConfig: (c: Partial<HubConfig>) => void;
}) {
  const { rooms, members, audit, status, error, addMessage, updateMessage, upsertRoom, removeRooms } = useHub(me?.handle ?? null, true, onMe);
  const [selected, setSelected] = useState<string | null>(null);
  const [newTop, setNewTop] = useState(false);
  const accounts = !config.demo;
  const canAddTop = !!me && isAdmin(me) && me.scopeRoomId === null;

  // A review link opens the room of that message.
  const [focus, setFocus] = useState<string | null>(review);
  const requestedFocus = useRef<string | null>(null);
  const consumeFocus = () => {
    if (!focus) return;
    setFocus(null);
    onReviewConsumed();
  };
  const selectRoom = (id: string) => {
    consumeFocus();
    setSelected(id);
  };
  const openSettings = () => {
    consumeFocus();
    setSelected(SETTINGS);
  };
  useEffect(() => {
    if (!focus) return;
    const room = Object.values(rooms).find((r) => r.messages.some((x) => x.id === focus));
    if (room) {
      setSelected(room.id);
      return;
    }
    if (!Object.keys(rooms).length || requestedFocus.current === focus) return;
    requestedFocus.current = focus;
    api.message(focus).then(
      (message) => {
        updateMessage(message);
        setSelected(message.roomId);
      },
      () => consumeFocus(),
    );
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
      <div className="grid h-dvh grid-cols-1 grid-rows-[auto_minmax(0,1fr)] bg-background md:grid-cols-[260px_minmax(0,1fr)] md:grid-rows-1">
        <aside className="flex max-h-[42dvh] min-h-0 flex-col gap-3 overflow-y-auto border-b border-sidebar-border bg-sidebar px-2 py-2 md:max-h-none md:gap-4 md:overflow-visible md:border-r md:border-b-0 md:py-3">
          <div className="flex min-h-11 flex-col justify-center gap-0.5 px-2">
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
            <RoomTree rooms={rooms} selected={selected} onSelect={selectRoom} me={me?.handle} />
          </nav>

          {me && accounts && (
            <div className="hidden items-center gap-1 border-t border-sidebar-border pt-2 md:flex">
              <button
                onClick={openSettings}
                aria-current={selected === SETTINGS ? "page" : undefined}
                className={cn(
                  "flex h-11 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 text-left transition-colors hover:bg-sidebar-accent",
                  selected === SETTINGS && "bg-accent",
                )}
              >
                <span className="relative">
                  <Avatar kind="human" name={me.name} size={28} />
                  <span
                    role="status"
                    aria-label={status === "live" ? t("Live") : status === "loading" ? t("Connecting to the hub") : t("Hub offline")}
                    title={status === "live" ? t("Live") : status === "loading" ? t("Connecting to the hub") : t("Hub offline")}
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-2.5 rounded-full border-2 border-sidebar",
                      status === "live" ? "bg-emerald-500" : status === "loading" ? "bg-sun" : "bg-coral",
                    )}
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{me.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">{me.org}</span>
                </span>
                <GearSixIcon aria-hidden className="text-muted-foreground" />
              </button>
              <Button variant="ghost" size="icon-sm" onClick={signOut} aria-label={t("Sign out")} title={t("Sign out")}>
                <SignOutIcon />
              </Button>
            </div>
          )}
          {me && accounts && (
            <div className="flex gap-2 px-1 md:hidden">
              <Button variant="ghost" size="sm" onClick={openSettings}>
                <GearSixIcon data-icon="inline-start" />
                {t("Settings")}
              </Button>
              <Button variant="ghost" size="sm" onClick={signOut}>
                <SignOutIcon data-icon="inline-start" />
                {t("Sign out")}
              </Button>
            </div>
          )}
          {!accounts && status !== "live" && (
            <p role="status" className={cn("hidden px-3 text-xs text-muted-foreground md:block", status === "offline" && "text-coral")}>
              {status === "loading" ? t("Connecting to the hub") : t("Hub offline")}
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
              onFocusConsumed={consumeFocus}
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
  onFocusConsumed,
}: {
  focus?: string | null;
  onFocusConsumed: () => void;
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
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const memberCount = Object.keys(members).length;
  const person = me?.kind === "human" ? me : null;

  // Refetch when someone joins, pauses or comes online, so the panel stays current.
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.paused ? 1 : 0}${m.online ? 1 : 0}${m.scopeRoomId}`)
    .join(",");
  const roomTopology = Object.values(rooms)
    .map((r) => `${r.id}:${r.parentId ?? ""}`)
    .sort()
    .join(",");
  useEffect(() => {
    api.roomMembers(room.id).then(setInRoom, () => setInRoom([]));
  }, [room.id, room.parentId, roomTopology, memberCount, memberState]);

  const path: Room[] = [];
  for (let r: Room | undefined = room; r; r = r.parentId ? rooms[r.parentId] : undefined) path.unshift(r);
  const open = (d: typeof dialog) => () => setDialog(d);
  const shut = (o: boolean) => !o && setDialog(null);

  return (
    <div className={cn("relative grid h-full min-w-0 grid-cols-1 overflow-hidden", detailsOpen && "xl:grid-cols-[minmax(0,1fr)_320px]")}>
      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <header className="flex h-[58px] shrink-0 items-center justify-between gap-3 border-b border-border px-3 md:px-5">
          <div className="flex min-w-0 items-center gap-2">
            <HashIcon aria-hidden weight="bold" className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h1 className="truncate font-sans text-[15px] font-semibold tracking-normal">{room.name}</h1>
              {path.length > 1 && <p className="m-0 truncate text-[11px] text-muted-foreground">{path.slice(0, -1).map((r) => r.name).join(" / ")}</p>}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => setDetailsOpen((v) => !v)} aria-pressed={detailsOpen}>
              <UsersIcon data-icon="inline-start" />
              <span className="tabular-nums">{inRoom.length}</span>
              <span className="sr-only">{t("Room details")}</span>
            </Button>
            <Popover open={actionsOpen} onOpenChange={setActionsOpen}>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="icon-sm" aria-label={t("More actions")} title={t("More actions")}>
                  <DotsThreeIcon weight="bold" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-56 p-1">
                {me && (
                  <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => (setActionsOpen(false), setDialog("room"))}>
                    <PlusIcon /> {t("New room inside")}
                  </button>
                )}
                {person && (
                  <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => (setActionsOpen(false), setDialog("invite"))}>
                    <UserPlusIcon /> {t("Invite")}
                  </button>
                )}
                {person && (person.scopeRoomId === null || person.scopeRoomId !== room.id) && (
                  <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent" onClick={() => (setActionsOpen(false), setDialog("settings"))}>
                    <GearSixIcon /> {t("Room settings")}
                  </button>
                )}
              </PopoverContent>
            </Popover>
          </div>
        </header>

        <Thread room={room} members={members} me={me} inRoom={inRoom} focus={focus} onFocusConsumed={onFocusConsumed} onUpdated={onUpdated} />

        <Composer room={room} me={me} inRoom={inRoom} onPosted={onPosted} />
      </section>

      {detailsOpen && (
        <RoomDetailsPanel
          room={room}
          inRoom={inRoom}
          members={members}
          me={me}
          audit={audit.filter((a) => a.roomId === room.id)}
          onClose={() => setDetailsOpen(false)}
          onContext={onContext}
          onAddAgent={person ? open("agent") : undefined}
        />
      )}

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
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 className="font-sans text-sm font-semibold tracking-normal">{t("About")}</h3>
        {canEdit && !editing && (
          <Button variant="ghost" size="icon-xs" aria-label={t("Edit")} title={t("Edit")} onClick={() => (setDraft(room.context), setEditing(true))}>
            <PencilSimpleIcon />
          </Button>
        )}
      </div>
      {editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={8}
            aria-label={t("Room context, markdown")}
            className="font-mono text-[12px]"
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
        <pre className="m-0 max-h-64 overflow-y-auto font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {room.context || t("No context yet. Write down what every agent in this room should know first.")}
        </pre>
      )}
    </section>
  );
}

function Thread({
  room,
  members,
  me,
  inRoom,
  focus,
  onFocusConsumed,
  onUpdated,
}: {
  room: Room;
  members: Record<string, Member>;
  me: Member | null;
  inRoom: Member[];
  focus?: string | null;
  onFocusConsumed: () => void;
  onUpdated: (m: Msg) => void;
}) {
  // Only messages that arrive while you're looking animate in; opening a room doesn't replay history.
  const [mountedAt] = useState(() => Date.now());
  // Opened from a review link (email, agent session): bring that message into view.
  useEffect(() => {
    if (!focus) return;
    const timer = setTimeout(() => {
      const target = document.getElementById(`msg-${focus}`);
      if (!target) return;
      target.focus({ preventScroll: true });
      target.scrollIntoView({ block: "center" });
      onFocusConsumed();
    }, 300);
    return () => clearTimeout(timer);
  }, [focus, room.id]);
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
              const sessionName = m.metadata?.from.sessionNameSnapshot ?? m.metadata?.from.sessionName;
              const forMe = !!me && isForMe(m, me.handle);
              const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
              return (
                <MessageScrollerItem key={m.id} messageId={m.id} scrollAnchor={m.from === me?.handle}>
                  <Message
                    id={`msg-${m.id}`}
                    tabIndex={focus === m.id ? -1 : undefined}
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
                        <span className="font-semibold text-foreground">
                          {author?.name ?? m.from}{sessionName ? ` · ${sessionName}` : ""}
                        </span>
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
  const gate = s.gate?.decision;
  const approval = s.flags.includes("needs-approval");
  const reasons = s.flags.filter((f) => f !== "needs-approval").map(flagLabel);
  const person = me?.kind === "human" && me.handle !== m.from ? me : null;
  const mine = (key: string) => !!person && (key === person.handle || key === `org:${person.org}`);
  const gateIsMine = gate === "pending" && !!person && (!approval || person.org === m.org);
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

      {gate === "pending" && (
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
          {s.status === "held" && myPending.length > 0 && buttons("agents", t("Release to my agents"))}
        </div>
      )}
      {error && <p role="alert" className="error w-full">{error}</p>}

      {!s.gate && !approvals.length && s.status === "delivered" && reasons.length > 0 && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldWarningIcon aria-hidden />
          {t("Flagged ({why}), delivered: no other company's agent is in this room", { why: reasons.join(", ") })}
        </span>
      )}
      {gate === "released" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ShieldCheckIcon aria-hidden />
          {approval
            ? t("Approved by @{who}", { who: s.gate?.by ?? s.reviewedBy ?? "" })
            : t("Released by @{who}", { who: s.gate?.by ?? s.reviewedBy ?? "" })}
        </span>
      )}
      {gate === "rejected" && (
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <ProhibitIcon aria-hidden />
          {t("Rejected by @{who}. No agent ever saw it.", { who: s.gate?.by ?? s.reviewedBy ?? "" })}
        </span>
      )}
    </div>
  );
}

/** Who a message reached: agents that got it, and the ones it waits for because they're offline. */
function DeliveryLine({ m, inRoom }: { m: Msg; inRoom: Member[] }) {
  if (m.safety?.status === "held" && m.safety.gate?.decision === "pending") return null;
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
    return <span className="flex self-start items-center gap-2 text-xs text-muted-foreground">{glyph}{label}</span>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2 self-start justify-start"
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
  const query = /(?:^|\s)@([a-z0-9_-]*(?:\/[a-z0-9_-]*)?)$/i.exec(text)?.[1]?.toLowerCase();
  type Suggestion = { value: string; name: string; detail: string; member?: Member };
  const everyone: Suggestion = { value: "room", name: "Everyone in this room", detail: "@room" };
  const addressable: Suggestion[] = inRoom
    .filter((m) => m.handle !== me?.handle)
    .flatMap((m) => [
      ...(m.kind === "agent"
        ? (m.sessions ?? []).map((session) => ({
            value: `${m.handle}/${session.name}`,
            name: `${m.name} · ${session.name}`,
            detail: session.online ? t("online") : t("offline"),
            member: m,
          }))
        : []),
      { value: m.handle, name: m.name, detail: m.kind === "agent" ? "agent inbox" : `@${m.handle}`, member: m },
    ]);
  const suggestions =
    query === undefined
      ? []
      : [...addressable, everyone]
          .filter((item) => item.value.startsWith(query) || item.name.toLowerCase().startsWith(query))
          .slice(0, 8);
  const open = suggestions.length > 0 && dismissed !== text;
  const active = suggestions.some((s) => s.value === pick) ? pick : suggestions[0]?.value ?? "";

  const complete = (address: string) => {
    setText((t) => t.replace(/@([a-z0-9_-]*(?:\/[a-z0-9_-]*)?)$/i, `@${address} `));
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
      const i = suggestions.findIndex((s) => s.value === active);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setPick(suggestions[(i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length].value);
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
    <form className="px-3 pt-2 pb-3 md:px-5 md:pb-5" onSubmit={(e) => (e.preventDefault(), send())}>
      <div className="rounded-xl border border-input bg-background shadow-[0_1px_2px_color-mix(in_srgb,var(--text)_5%,transparent)] transition-[border-color,box-shadow] focus-within:border-foreground/40 focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--blue)_12%,transparent)]">
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
              className="min-h-16 resize-none rounded-none border-0 bg-transparent px-3 pt-3 pb-1 text-[15px] shadow-none focus-visible:ring-0 dark:bg-transparent"
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
                  {suggestions.map((item) => (
                    <CommandItem key={item.value} value={item.value} onSelect={complete} className="gap-2.5">
                      {item.member && <Avatar kind={item.member.kind} name={item.name} size={22} />}
                      <span className="font-medium">{item.name}</span>
                      <span className="ml-auto text-xs text-muted-foreground">@{item.value}{item.detail.startsWith("@") ? "" : ` · ${item.detail}`}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <div className="flex items-center justify-between gap-3 px-2 pb-2">
          <Select value={kind} onValueChange={(v) => setKind(v as MessageKind)}>
            <SelectTrigger size="sm" aria-label={t("What kind of message")} className={cn("border-0 px-2 shadow-none", kind === "contract_change" && "text-coral")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {kinds().map((k) => <SelectItem key={k.kind} value={k.kind}>{k.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Button type="submit" size="icon-sm" disabled={!text.trim() || sending} aria-label={sending ? t("Sending") : t("Send")} title={sending ? t("Sending") : t("Send")}>
            <PaperPlaneRightIcon weight="fill" />
          </Button>
        </div>
      </div>
      {error && <p className="error">{error}</p>}
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

function RoomDetailsPanel({
  room,
  inRoom,
  members,
  me,
  audit,
  onClose,
  onContext,
  onAddAgent,
}: {
  room: Room;
  inRoom: Member[];
  members: Record<string, Member>;
  me: Member | null;
  audit: AuditEvent[];
  onClose: () => void;
  onContext: (r: Room) => void;
  onAddAgent?: () => void;
}) {
  // People first, each with their agents under them; agents whose person isn't in the room at the end.
  const humans = inRoom.filter((m) => m.kind === "human");
  const agentsOf = (h: Member) => inRoom.filter((a) => a.kind === "agent" && ownerOf(a, members)?.handle === h.handle);
  const orphans = inRoom.filter((a) => a.kind === "agent" && !humans.some((h) => ownerOf(a, members)?.handle === h.handle));
  const orgs = [...new Set(humans.map((h) => h.org))];

  return (
    <aside aria-label={t("Room details")} className="absolute inset-y-0 right-0 z-20 flex w-[min(360px,calc(100vw-20px))] min-h-0 flex-col border-l border-border bg-card shadow-[-12px_0_32px_color-mix(in_srgb,var(--text)_10%,transparent)] xl:static xl:w-auto xl:shadow-none">
      <header className="flex h-[58px] shrink-0 items-center justify-between border-b border-border px-4">
        <div className="flex items-center gap-2">
          <InfoIcon aria-hidden className="text-muted-foreground" />
          <h2 className="font-sans text-[15px] font-semibold tracking-normal">{t("Room details")}</h2>
        </div>
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label={t("Close details")} title={t("Close details")}>
          <XIcon />
        </Button>
      </header>
      <div className="flex min-h-0 flex-col gap-6 overflow-y-auto px-4 py-5">
        <RoomContext room={room} canEdit={!!me} onSaved={onContext} />
        <PolicyToggle room={room} me={me} />
        <div className="h-px bg-border" />
        <section className="flex flex-col gap-4">
          <div className="flex items-center justify-between gap-3">
            <h3 className="font-sans text-sm font-semibold tracking-normal">{t("In this room")}</h3>
            <span className="text-xs tabular-nums text-muted-foreground">{inRoom.length}</span>
          </div>
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
        </section>
        <div className="h-px bg-border" />
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
    <div>
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
      {!!m.sessions?.length && (
        <ul className="mt-1 ml-10 flex flex-col gap-1 border-l border-border pl-3">
          {m.sessions.map((session) => (
            <li key={session.name} className="flex items-center gap-2 text-xs">
              <span className={cn("size-1.5 rounded-full", session.online ? "bg-emerald-500" : "border border-muted-foreground")} aria-hidden />
              <span className="font-medium text-foreground">{session.name}</span>
              <span className="text-muted-foreground">{session.online ? t("online") : t("offline")}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
