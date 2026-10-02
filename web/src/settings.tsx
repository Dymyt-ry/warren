// Settings: your account, the people on this hub (owners and admins), pending
// invites and agents. Lists are rows separated by space, not cards (web/DESIGN.md).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Field } from "./account";
import { AgentDialog, CopyField, InviteDialog, RoomSelect } from "./dialogs";
import { api, roomPath, type HubConfig, type Invite, type Member, type NewAgent, type Role, type Room, type User } from "./api";
import { Avatar } from "./ui";

const isAdmin = (m: Member) => m.role === "owner" || m.role === "admin";
const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member" };

function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="font-heading text-lg">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="m-0 text-sm text-muted-foreground">{children}</p>;

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [T | null, () => void, string | null] {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    load().then(
      (d) => (setData(d), setError(null)),
      (e) => setError((e as Error).message),
    );
  }, [...deps, n]);
  return [data, () => setN((x) => x + 1), error];
}

export function Settings({
  me,
  config,
  rooms,
  members,
  onMe,
}: {
  me: Member;
  config: HubConfig;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  onMe: (m: Member) => void;
}) {
  const admin = isAdmin(me);
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.online ? 1 : 0}${m.paused ? 1 : 0}${m.scopeRoomId}${m.role}`)
    .join(",");
  const [users, reloadUsers] = useLoad(() => (admin ? api.users() : Promise.resolve([] as User[])), [admin, memberState]);
  const [invites, reloadInvites] = useLoad(() => api.invites(), [admin]);
  const [agents, reloadAgents] = useLoad(() => api.agents(), [memberState]);
  const [inviting, setInviting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [rotated, setRotated] = useState<NewAgent | null>(null);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-[760px] flex-col gap-12 px-4 py-6 md:px-8 md:py-10">
        <header className="flex flex-col gap-1">
          <h1 className="font-heading text-2xl">Settings</h1>
          <Quiet>
            {config.instanceName} · Warren {config.version}
          </Quiet>
        </header>

        <Account me={me} onMe={onMe} />

        {admin && (
          <Section
            title="People"
            action={
              <Button size="sm" onClick={() => setInviting(true)}>
                <PlusIcon data-icon="inline-start" weight="bold" />
                Invite a person
              </Button>
            }
          >
            <ul className="flex flex-col gap-1">
              {(users ?? []).map((u) => (
                <UserRow key={u.handle} u={u} me={me} rooms={rooms} onChanged={reloadUsers} />
              ))}
            </ul>
          </Section>
        )}

        <Section
          title={admin ? "Pending invites" : "Invites you sent"}
          action={
            !admin && (
              <Button size="sm" onClick={() => setInviting(true)}>
                <PlusIcon data-icon="inline-start" weight="bold" />
                Invite a person
              </Button>
            )
          }
        >
          {invites?.length ? (
            <ul className="flex flex-col gap-1">
              {invites.map((i) => (
                <InviteRow key={i.id} i={i} onRevoked={reloadInvites} />
              ))}
            </ul>
          ) : (
            <Quiet>No open invites. Links you create show up here until someone uses them.</Quiet>
          )}
        </Section>

        <Section
          title={admin ? "Agents" : "Your agents"}
          action={
            <Button size="sm" onClick={() => setAdding(true)}>
              <PlusIcon data-icon="inline-start" weight="bold" />
              Add an agent
            </Button>
          }
        >
          {agents?.length ? (
            <ul className="flex flex-col gap-1">
              {agents.map((a) => (
                <AgentRow key={a.handle} a={a} rooms={rooms} members={members} onRotated={setRotated} onChanged={reloadAgents} />
              ))}
            </ul>
          ) : (
            <Quiet>No agents yet. Add one and paste its setup into Claude Code, Codex or Cursor.</Quiet>
          )}
        </Section>
      </div>

      <InviteDialog open={inviting} onOpenChange={setInviting} me={me} rooms={rooms} room={null} emailOn={config.email} onInvited={reloadInvites} />
      <AgentDialog open={adding} onOpenChange={setAdding} me={me} rooms={rooms} room={null} onAdded={reloadAgents} />
      <AgentDialog open={!!rotated} onOpenChange={(o) => !o && setRotated(null)} me={me} rooms={rooms} room={null} existing={rotated} />
    </div>
  );
}

function Account({ me, onMe }: { me: Member; onMe: (m: Member) => void }) {
  const [name, setName] = useState(me.name);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    api.updateMe(name).then(
      (m) => (onMe(m), setNote({ ok: true, text: "Name saved." })),
      (err) => setNote({ ok: false, text: (err as Error).message }),
    );
  };
  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    api.changePassword(current, next).then(
      () => (setCurrent(""), setNext(""), setNote({ ok: true, text: "Password changed. Other sessions were signed out." })),
      (err) => setNote({ ok: false, text: (err as Error).message }),
    );
  };

  return (
    <Section title="Your account">
      <div className="flex flex-col gap-1 text-sm">
        <span>
          @{me.handle} · {me.email} · {me.org}
        </span>
        <span className="text-muted-foreground">
          {ROLE_LABEL[me.role ?? "member"]}
          {me.scopeRoomId === null ? ", sees every room" : ""}
        </span>
      </div>
      <form className="flex items-end gap-2" onSubmit={saveName}>
        <div className="flex-1">
          <Field label="Name">
            <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="outline" disabled={name.trim() === me.name || !name.trim()}>
          Save
        </Button>
      </form>
      <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={savePassword}>
        <input type="email" hidden readOnly autoComplete="username" value={me.email ?? ""} />
        <Field label="Current password">
          <Input required type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="New password">
          <Input required type="password" minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <Button type="submit" variant="outline">
          Change password
        </Button>
      </form>
      {note && <p className={note.ok ? "m-0 text-[13px] text-muted-foreground" : "error"}>{note.text}</p>}
    </Section>
  );
}

function UserRow({ u, me, rooms, onChanged }: { u: User; me: Member; rooms: Record<string, Room>; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<{ url: string; emailed: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const isOwner = u.role === "owner";
  const isMe = u.handle === me.handle;
  const canEdit = !isMe && (!isOwner || me.role === "owner");
  const act = (p: Promise<unknown>) => p.then(onChanged, (e) => setError((e as Error).message));

  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar kind="human" name={u.name} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {u.name}
            {isMe && <span className="ml-1.5 text-xs font-medium text-primary">you</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            @{u.handle} · {u.email ?? "no email"} · {u.org}
            {u.agents ? ` · ${u.agents} agent${u.agents === 1 ? "" : "s"}` : ""}
          </div>
        </div>
        {canEdit && !isOwner ? (
          <Select value={u.role ?? "member"} onValueChange={(role) => act(api.updateUser(u.handle, { role: role as Role, ...(role === "member" ? { room: Object.keys(rooms)[0] } : {}) }))}>
            <SelectTrigger size="sm" className="w-28" aria-label={`Role of ${u.name}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {me.role === "owner" && <SelectItem value="owner">Owner</SelectItem>}
              <SelectItem value="admin">Admin</SelectItem>
              <SelectItem value="member">Member</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="w-28 px-2 text-xs text-muted-foreground">{ROLE_LABEL[u.role ?? "member"]}</span>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 pl-[42px]">
        {u.role === "member" && canEdit ? (
          <div className="w-64">
            <RoomSelect rooms={rooms} value={u.scopeRoomId} onChange={(room) => room && act(api.updateUser(u.handle, { room }))} label={`What ${u.name} sees`} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Sees {roomPath(u.scopeRoomId, rooms)}</span>
        )}
        {canEdit && (
          <>
            <Button size="xs" variant="ghost" onClick={() => api.resetLink(u.handle).then(setReset, (e) => setError((e as Error).message))}>
              Password reset link
            </Button>
            {confirm ? (
              <>
                <Button size="xs" variant="destructive" onClick={() => act(api.removeUser(u.handle))}>
                  Remove {u.name} and their agents
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirm(false)}>
                  Keep
                </Button>
              </>
            ) : (
              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
                Remove
              </Button>
            )}
          </>
        )}
      </div>
      {reset && (
        <div className="pl-[42px]">
          <CopyField label={reset.emailed ? `Emailed to ${u.email}; valid for a day` : "Send this to them; it works once, for a day"} value={reset.url} />
        </div>
      )}
      {error && <p className="error pl-[42px]">{error}</p>}
    </li>
  );
}

function InviteRow({ i, onRevoked }: { i: Invite; onRevoked: () => void }) {
  const until = new Date(i.expiresAt).toLocaleDateString([], { day: "numeric", month: "short" });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/40">
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate font-medium">{i.email ?? "Anyone with the link"}</div>
        <div className="truncate text-xs text-muted-foreground">
          {i.org} · {i.role === "admin" ? "admin, every room" : (i.roomName ?? i.room)} · by @{i.invitedBy ?? "admin"} · until {until}
        </div>
      </div>
      <Button size="xs" variant="ghost" onClick={() => api.revokeInvite(i.id).then(onRevoked)}>
        Revoke
      </Button>
    </li>
  );
}

const ADAPTER_LABEL: Record<Member["adapter"], string> = {
  channel: "pushed into its session",
  exec: "woken on mention",
  inbox: "reads its inbox",
  a2a: "A2A",
  dashboard: "dashboard",
};

function AgentRow({
  a,
  rooms,
  members,
  onRotated,
  onChanged,
}: {
  a: Member;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  onRotated: (a: NewAgent) => void;
  onChanged: () => void;
}) {
  const [confirm, setConfirm] = useState<"token" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const owner = a.owner ? members[a.owner]?.name ?? `@${a.owner}` : "nobody";
  const fail = (e: unknown) => setError((e as Error).message);
  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar kind="agent" name={a.name} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{a.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            @{a.handle} · {a.org} · {owner}'s · {ADAPTER_LABEL[a.adapter]}
            {a.paused ? " · paused" : a.online ? " · online" : ""}
          </div>
        </div>
        <div className="w-56">
          <RoomSelect rooms={rooms} value={a.scopeRoomId} onChange={(room) => room && api.updateAgent(a.handle, { room }).then(onChanged, fail)} label={`What ${a.name} sees`} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-[42px]">
        {confirm === "token" ? (
          <>
            <Button size="xs" onClick={() => api.rotateAgent(a.handle).then((r) => (setConfirm(null), onRotated(r)), fail)}>
              Replace token
            </Button>
            <span className="self-center text-xs text-muted-foreground">The running agent loses access until you paste the new one.</span>
            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </>
        ) : confirm === "remove" ? (
          <>
            <Button size="xs" variant="destructive" onClick={() => api.removeAgent(a.handle).then(onChanged, fail)}>
              Remove @{a.handle}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
              Keep
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="ghost" onClick={() => setConfirm("token")}>
              New token
            </Button>
            <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirm("remove")}>
              Remove
            </Button>
          </>
        )}
      </div>
      {error && <p className="error pl-[42px]">{error}</p>}
    </li>
  );
}
