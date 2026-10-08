// Dialogs for shaping the tree and bringing people in: new room, room
// settings (rename, move, delete), invite a person, add an agent.
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field } from "./account";
import { t } from "./i18n";
import { api, roomOptions, roomPath, type Adapter, type Invite, type Member, type NewAgent, type Room } from "./api";

const isAdmin = (m: Member | null) => m?.role === "owner" || m?.role === "admin";
const TOP = "__top";

/** Room picker in tree order. `allowTop` adds "Top level" (value null). */
export function RoomSelect({
  rooms,
  value,
  onChange,
  allowTop,
  exclude,
  label = "Room",
}: {
  rooms: Record<string, Room>;
  value: string | null;
  onChange: (id: string | null) => void;
  allowTop?: string;
  exclude?: (id: string) => boolean;
  label?: string;
}) {
  const selectValue = value === null ? (allowTop ? TOP : undefined) : value;
  return (
    <Select value={selectValue} onValueChange={(v) => onChange(v === TOP ? null : v)}>
      <SelectTrigger className="w-full" aria-label={label}>
        <SelectValue placeholder={t("Choose a room")} />
      </SelectTrigger>
      <SelectContent>
        {allowTop && <SelectItem value={TOP}>{allowTop}</SelectItem>}
        {roomOptions(rooms)
          .filter(({ room }) => !exclude?.(room.id))
          .map(({ room, depth }) => (
            <SelectItem key={room.id} value={room.id}>
              <span style={{ paddingLeft: depth * 14 }}>{room.name}</span>
            </SelectItem>
          ))}
      </SelectContent>
    </Select>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, setError };
}

export function CopyField({ value, label, multiline }: { value: string; label: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  const labelId = useId();
  const copy = () =>
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span id={labelId} className="text-[13px] font-medium">{label}</span>
        <Button type="button" variant="ghost" size="xs" onClick={copy}>
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      {multiline ? (
        <pre
          role="textbox"
          aria-readonly="true"
          aria-labelledby={labelId}
          className="m-0 max-h-48 overflow-auto rounded-lg bg-muted px-3 py-2 font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-all"
        >
          {value}
        </pre>
      ) : (
        <Input readOnly value={value} aria-labelledby={labelId} onFocus={(e) => e.target.select()} className="font-mono text-[12px]" />
      )}
    </div>
  );
}

function Shell({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle className="font-heading text-lg">{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

// --- rooms --------------------------------------------------------------------

export function NewRoomDialog({
  open,
  onOpenChange,
  parent,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parent: Room | null; // null: a top-level room
  onCreated: (r: Room) => void;
}) {
  const [name, setName] = useState("");
  const [context, setContext] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      onCreated(await api.createRoom(parent?.id ?? null, name.trim(), context));
      setName("");
      setContext("");
      onOpenChange(false);
    });
  };
  return (
    <Shell
      open={open}
      onOpenChange={onOpenChange}
      title={parent ? `New room inside ${parent.name}` : "New top-level room"}
      description={
        parent
          ? `Everyone who sees ${parent.name} sees the new room too. Give a task or a topic its own room to keep the thread short.`
          : "A new tree: only owners, admins and the people you invite into it will see it."
      }
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t("Name")}>
          <Input required autoFocus maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={t("basket-migration")} />
        </Field>
        <Field label={t("Context")} hint={t("Markdown every agent reads before working here: the contract, decisions, conventions. You can change it later.")}>
          <Textarea rows={4} value={context} onChange={(e) => setContext(e.target.value)} className="font-mono text-[13px]" />
        </Field>
        {error && <p className="error">{error}</p>}
        <DialogFooter>
          <Button type="submit" disabled={busy || !name.trim()}>{t("Create room")}</Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

export function RoomSettingsDialog({
  open,
  onOpenChange,
  room,
  rooms,
  me,
  onDeleted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  room: Room;
  rooms: Record<string, Room>;
  me: Member;
  onDeleted: (ids: string[]) => void;
}) {
  const [name, setName] = useState(room.name);
  const [parent, setParent] = useState<string | null>(room.parentId);
  const [confirm, setConfirm] = useState(false);
  const { busy, error, run } = useAction();
  const unscopedAdmin = isAdmin(me) && me.scopeRoomId === null;
  const isScopeRoom = me.scopeRoomId === room.id;
  const canDelete = !isScopeRoom && (isAdmin(me) || room.createdBy === me.handle);
  const inside = (id: string) => {
    for (let r: Room | undefined = rooms[id]; r; r = r.parentId ? rooms[r.parentId] : undefined) if (r.id === room.id) return true;
    return false;
  };
  const below = Object.values(rooms).filter((r) => r.id !== room.id && inside(r.id)).length;

  const save = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      await api.updateRoom(room.id, { name: name.trim(), ...(parent !== room.parentId ? { parentId: parent } : {}) });
      onOpenChange(false);
    });
  };
  const remove = () =>
    run(async () => {
      const { deleted } = await api.deleteRoom(room.id);
      onDeleted(deleted);
      onOpenChange(false);
    });

  return (
    <Shell open={open} onOpenChange={onOpenChange} title={`${room.name} settings`}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Field label={t("Name")}>
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        {!isScopeRoom && (
          <Field
            label={t("Inside")}
            hint={t("Moving a room changes who sees it: everyone with access to the new parent will, and people who only saw the old one won't.")}
          >
            <RoomSelect rooms={rooms} value={parent} onChange={setParent} allowTop={unscopedAdmin ? "Top level" : undefined} exclude={inside} label={t("Parent room")} />
          </Field>
        )}
        {canDelete && (
          <div className="flex flex-col gap-2 pt-2">
            <p className="m-0 text-[13px] text-muted-foreground">
              Deleting removes {room.name}
              {below ? ` and the ${below} room${below === 1 ? "" : "s"} inside it` : ""}, with every message and claim. The safety log keeps what happened.
            </p>
            {confirm ? (
              <div className="flex gap-2">
                <Button type="button" variant="destructive" disabled={busy} onClick={remove}>{t("Delete for good")}</Button>
                <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>{t("Keep it")}</Button>
              </div>
            ) : (
              <Button type="button" variant="ghost" className="-ml-2.5 self-start text-destructive" onClick={() => setConfirm(true)}>{t("Delete room")}</Button>
            )}
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <DialogFooter>
          <Button type="submit" disabled={busy || !name.trim()}>{t("Save")}</Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

// --- people and agents -----------------------------------------------------------

const EVERY = "__every";

export function InviteDialog({
  open,
  onOpenChange,
  me,
  rooms,
  room,
  emailOn,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  me: Member;
  rooms: Record<string, Room>;
  room: string | null; // preselected
  emailOn: boolean;
  onInvited?: (i: Invite) => void;
}) {
  const admin = isAdmin(me);
  const [email, setEmail] = useState("");
  const [org, setOrg] = useState(me.org);
  const [where, setWhere] = useState<string>(room ?? me.scopeRoomId ?? Object.keys(rooms)[0] ?? EVERY);
  const [result, setResult] = useState<Invite | null>(null);
  const { busy, error, run } = useAction();
  const guest = org.trim() !== me.org;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setTimeout(() => (setResult(null), setEmail("")), 200);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    run(async () => {
      const i = await api.invite({
        email: email.trim() || undefined,
        org: org.trim(),
        ...(where === EVERY ? { role: "admin" as const } : { room: where }),
      });
      setResult(i);
      onInvited?.(i);
    });
  };

  if (result)
    return (
      <Shell
        open={open}
        onOpenChange={close}
        title={t("Invite ready")}
        description={
          result.emailed
            ? `We emailed it to ${result.email}. You can also send the link yourself.`
            : "Send this link to them. It works once, for 7 days, and only you see it now."
        }
      >
        <CopyField label={t("Invite link")} value={result.url!} />
        <DialogFooter>
          <Button onClick={() => close(false)}>{t("Done")}</Button>
        </DialogFooter>
      </Shell>
    );

  return (
    <Shell
      open={open}
      onOpenChange={close}
      title={t("Invite a person")}
      description={t("They set their own password from the link, see the room you pick and everything inside it, and can add their own agents there.")}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t("Email")} hint={emailOn ? "Optional. We email the link when you fill it in." : "Optional. This hub can't send email, so you'll get a link to pass on."}>
          <Input type="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} placeholder={t("ben@firmab.dev")} />
        </Field>
        <Field
          label={t("Company")}
          hint={
            admin
              ? guest
                ? `A guest company. Its people approve its own agents' changes, and its suspicious messages wait for someone of ${me.org}.`
                : "Your company. Change it to invite a guest from another company."
              : "People you invite join your company. An admin can invite other companies."
          }
        >
          <Input required disabled={!admin} value={org} onChange={(e) => setOrg(e.target.value)} />
        </Field>
        <Field label={t("Access")} hint={where === EVERY ? "Admins see every room and manage people, agents and rooms." : `Sees ${roomPath(where, rooms)} and everything inside it.`}>
          <Select value={where} onValueChange={setWhere}>
            <SelectTrigger className="w-full" aria-label={t("Access")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {admin && me.scopeRoomId === null && <SelectItem value={EVERY}>{t("Every room, as an admin")}</SelectItem>}
              {roomOptions(rooms).map(({ room: r, depth }) => (
                <SelectItem key={r.id} value={r.id}>
                  <span style={{ paddingLeft: depth * 14 }}>{r.name}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {error && <p className="error">{error}</p>}
        <DialogFooter>
          <Button type="submit" disabled={busy}>{t("Create invite link")}</Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}

const CLIENTS: { id: string; label: string; adapter: Adapter; note: string }[] = [
  { id: "claude", label: "Claude Code", adapter: "channel", note: "Mentions are pushed straight into the running session." },
  { id: "codex", label: "Codex", adapter: "exec", note: "A mention is queued directly into its bound session." },
  { id: "cursor", label: "Cursor", adapter: "exec", note: "A mention wakes its chat with cursor-agent --resume." },
  { id: "other", label: "Other MCP", adapter: "inbox", note: "Any MCP client: it reads its inbox when it checks in." },
];

export function AgentSetup({ agent, client }: { agent: NewAgent; client: string }) {
  const s = agent.setup;
  return (
    <div className="flex flex-col gap-4">
      <CopyField label={t("Token")} value={agent.token} />
      {client !== "other" && <CopyField label={t("Connect from the project folder")} value={s.cli[client as "claude" | "codex" | "cursor"]} multiline />}
      {client === "claude" && (
        <CopyField label={t("Start Claude Code with live push")} value={s.claudeCode.launch} />
      )}
      {client === "codex" && (
        <CopyField label={t("Enable live CLI push")} value={s.codex.wake} multiline />
      )}
      {client === "cursor" && (
        <>
          <CopyField label={t("Add to .cursor/mcp.json")} value={JSON.stringify(s.cursor.mcpJson, null, 2)} multiline />
          <CopyField label={t("Wake it on mentions (bridge, next to Cursor)")} value={s.cursor.wake} multiline />
        </>
      )}
      {client === "other" && (
        <>
          <CopyField label={t("MCP over HTTP")} value={JSON.stringify(s.cursor.mcpJson, null, 2)} multiline />
          <CopyField label={t("A2A agent card")} value={`${s.a2a.card}\n${s.a2a.auth}`} multiline />
        </>
      )}
      <p className="m-0 text-xs leading-relaxed text-muted-foreground">{t("The token is shown only now. Lost it? Make a new one in Settings; the old one stops working at once.")}</p>
    </div>
  );
}

export function AgentDialog({
  open,
  onOpenChange,
  rooms,
  room,
  me,
  existing,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rooms: Record<string, Room>;
  room: string | null;
  me: Member;
  existing?: NewAgent | null; // show setup for a token that was just rotated
  onAdded?: (a: NewAgent) => void;
}) {
  const [client, setClient] = useState("claude");
  const [name, setName] = useState("");
  const [where, setWhere] = useState<string | null>(room ?? me.scopeRoomId ?? Object.keys(rooms)[0] ?? null);
  const [result, setResult] = useState<NewAgent | null>(null);
  const { busy, error, run } = useAction();
  const picked = CLIENTS.find((c) => c.id === client)!;
  const shown = existing ?? result;

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) setTimeout(() => (setResult(null), setName("")), 200);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!where) return;
    run(async () => {
      const a = await api.addAgent({ name: name.trim() || `${picked.label} (${me.name})`, room: where, adapter: picked.adapter });
      setResult(a);
      onAdded?.(a);
    });
  };

  if (shown)
    return (
      <Shell
        open={open}
        onOpenChange={close}
        title={`Connect @${shown.handle}`}
        description={`It sees ${roomPath(shown.scopeRoomId, rooms)} and everything inside it, and speaks for ${shown.org}.`}
      >
        {existing && (
          <ToggleGroup type="single" size="sm" value={client} onValueChange={(v) => v && setClient(v)} aria-label={t("Client")}>
            {CLIENTS.map((c) => (
              <ToggleGroupItem key={c.id} value={c.id}>
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        <AgentSetup agent={shown} client={client} />
        <DialogFooter>
          <Button onClick={() => close(false)}>{t("Done")}</Button>
        </DialogFooter>
      </Shell>
    );

  return (
    <Shell
      open={open}
      onOpenChange={close}
      title={t("Add an agent")}
      description={`Your agent joins as a member of ${me.org}. People pause it, and it reaches others only by @mention.`}
    >
      <form className="flex flex-col gap-4" onSubmit={submit}>
        <Field label={t("Client")} hint={picked.note}>
          <ToggleGroup type="single" size="sm" value={client} onValueChange={(v) => v && setClient(v)} aria-label={t("Client")} className="flex-wrap">
            {CLIENTS.map((c) => (
              <ToggleGroupItem key={c.id} value={c.id}>
                {c.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
        <Field label={t("Name")} hint={t("Its @handle is made from the name.")}>
          <Input maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder={`${picked.label} (${me.name})`} />
        </Field>
        <Field label={t("Room")} hint={t("What it sees: this room and everything inside it.")}>
          <RoomSelect rooms={rooms} value={where} onChange={setWhere} />
        </Field>
        {error && <p className="error">{error}</p>}
        <DialogFooter>
          <Button type="submit" disabled={busy || !where}>{t("Add agent")}</Button>
        </DialogFooter>
      </form>
    </Shell>
  );
}
