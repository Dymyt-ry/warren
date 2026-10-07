// Settings: profile and appearance, sign-in security, safety, privacy, the
// people on this hub (owners and admins), invites, agents and hub settings.
// Rows separated by space, not cards (web/DESIGN.md).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  BuildingsIcon,
  KeyIcon,
  LockKeyIcon,
  PlusIcon,
  RobotIcon,
  ShieldCheckIcon,
  UserCircleIcon,
  UsersIcon,
} from "@phosphor-icons/react";
import { renderSVG } from "uqr";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Field } from "./account";
import { AgentDialog, CopyField, InviteDialog, RoomSelect } from "./dialogs";
import {
  api,
  ApiError,
  DEFAULT_PREFS,
  roomPath,
  type ApproverKey,
  type HubConfig,
  type Invite,
  type Member,
  type NewAgent,
  type Prefs,
  type Role,
  type Room,
  type User,
} from "./api";
import { applyTheme, formatDate, LANGUAGES, plural, setLanguage, t, useLanguage } from "./i18n";
import { Avatar } from "./ui";
import { cn } from "@/lib/utils";

const isAdmin = (m: Member) => m.role === "owner" || m.role === "admin";
const roleLabel = (r: Role | null | undefined) => (r === "owner" ? t("Owner") : r === "admin" ? t("Admin") : t("Member"));

type Tab = "profile" | "security" | "safety" | "privacy" | "people" | "agents" | "hub";

function Section({ title, lead, action, children }: { title: string; lead?: ReactNode; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex max-w-[56ch] flex-col gap-1">
          <h2 className="font-heading text-lg">{title}</h2>
          {lead && <p className="m-0 text-sm leading-relaxed text-muted-foreground">{lead}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

const Quiet = ({ children }: { children: ReactNode }) => <p className="m-0 text-sm text-muted-foreground">{children}</p>;

function Note({ note }: { note: { ok: boolean; text: string } | null }) {
  if (!note) return null;
  return <p role="status" aria-live="polite" className={note.ok ? "m-0 text-[13px] text-muted-foreground" : "error"}>{note.text}</p>;
}

function Switch({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: ReactNode }) {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input type="checkbox" className="mt-1 size-4 accent-[var(--blue)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{label}</span>
        {hint && <span className="text-[13px] leading-relaxed text-muted-foreground">{hint}</span>}
      </span>
    </label>
  );
}

type LoadState<T> = { status: "loading" } | { status: "error"; error: string } | { status: "data"; data: T };

function useLoad<T>(load: () => Promise<T>, deps: unknown[]): [LoadState<T>, () => void] {
  const [state, setState] = useState<LoadState<T>>({ status: "loading" });
  const [n, setN] = useState(0);
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    load().then(
      (data) => active && setState({ status: "data", data }),
      (error) => active && setState({ status: "error", error: (error as Error).message }),
    );
    return () => {
      active = false;
    };
  }, [...deps, n]);
  return [state, () => setN((x) => x + 1)];
}

function LoadError({ message, error, retry }: { message: string; error: string; retry: () => void }) {
  return (
    <div className="flex flex-col items-start gap-2">
      <p className="error m-0">
        {message} ({error})
      </p>
      <Button size="sm" variant="outline" onClick={retry}>
        {t("Retry")}
      </Button>
    </div>
  );
}

export function Settings({
  me,
  config,
  rooms,
  members,
  onMe,
  onConfig,
}: {
  me: Member;
  config: HubConfig;
  rooms: Record<string, Room>;
  members: Record<string, Member>;
  onMe: (m: Member | null) => void;
  onConfig: (c: Partial<HubConfig>) => void;
}) {
  useLanguage();
  const admin = isAdmin(me);
  const [tab, setTab] = useState<Tab>("profile");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const tabs = [
    { id: "profile" as Tab, label: t("Profile"), icon: UserCircleIcon },
    { id: "security" as Tab, label: t("Sign-in"), icon: KeyIcon },
    { id: "safety" as Tab, label: t("Safety"), icon: ShieldCheckIcon },
    { id: "privacy" as Tab, label: t("Privacy"), icon: LockKeyIcon },
    { id: "people" as Tab, label: admin ? t("People") : t("Invites"), icon: UsersIcon },
    { id: "agents" as Tab, label: t("Agents"), icon: RobotIcon },
    ...(admin ? [{ id: "hub" as Tab, label: t("Hub"), icon: BuildingsIcon }] : []),
  ];

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[1040px] px-4 py-6 md:px-8 md:py-9">
        <header className="border-b border-border pb-5">
          <h1 className="font-heading text-2xl">{t("Settings")}</h1>
          <Quiet>{config.instanceName} · Warren {config.version}</Quiet>
        </header>

        <div className="grid gap-8 pt-4 md:grid-cols-[200px_minmax(0,1fr)] md:gap-12 md:pt-7">
          <nav aria-label={t("Settings")} role="tablist" className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 md:sticky md:top-0 md:mx-0 md:flex-col md:self-start md:overflow-visible md:p-0">
            {tabs.map((x) => {
              const Icon = x.icon;
              return (
                <button
                  key={x.id}
                  id={`settings-tab-${x.id}`}
                  type="button"
                  role="tab"
                  aria-selected={tab === x.id}
                  aria-controls={`settings-panel-${x.id}`}
                  onClick={() => setTab(x.id)}
                  className={cn(
                    "flex h-9 shrink-0 items-center gap-2 rounded-lg px-2.5 text-left text-sm transition-colors hover:bg-muted md:w-full",
                    tab === x.id ? "bg-muted font-semibold text-foreground" : "text-muted-foreground",
                  )}
                >
                  <Icon aria-hidden className="size-4" />
                  {x.label}
                </button>
              );
            })}
          </nav>

          <div id={`settings-panel-${tab}`} role="tabpanel" aria-labelledby={`settings-tab-${tab}`} className="flex min-w-0 flex-col gap-8 pb-12">
            {tab === "profile" && <Profile me={me} onMe={onMe} />}
            {tab === "security" && <Security me={me} onMe={onMe} codes={recoveryCodes} onCodes={setRecoveryCodes} />}
            {tab === "safety" && <Safety me={me} onMe={onMe} emailOn={config.email} />}
            {tab === "privacy" && <Privacy me={me} config={config} onMe={onMe} />}
            {tab === "people" && <People me={me} config={config} rooms={rooms} members={members} />}
            {tab === "agents" && <Agents me={me} rooms={rooms} members={members} />}
            {tab === "hub" && admin && <Hub config={config} onConfig={onConfig} />}
          </div>
        </div>
      </div>
    </div>
  );
}

// --- profile and appearance ----------------------------------------------------------

function Profile({ me, onMe }: { me: Member; onMe: (m: Member) => void }) {
  const [name, setName] = useState(me.name);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const prefs = me.prefs ?? DEFAULT_PREFS;

  const saveName = (e: FormEvent) => {
    e.preventDefault();
    api.updateMe(name).then(
      (m) => (onMe(m), setNote({ ok: true, text: t("Name saved.") })),
      (err) => setNote({ ok: false, text: (err as Error).message }),
    );
  };
  const setPref = (patch: Partial<Prefs>) => {
    if (patch.language) setLanguage(patch.language);
    if (patch.theme) applyTheme(patch.theme);
    api.setPrefs(patch).then(onMe, (err) => setNote({ ok: false, text: (err as Error).message }));
  };

  return (
    <>
      <Section title={t("Profile")}>
        <div className="flex flex-col gap-1 text-sm">
          <span>
            @{me.handle} · {me.email} · {me.org}
          </span>
          <span className="text-muted-foreground">
            {roleLabel(me.role)}
            {me.scopeRoomId === null ? `, ${t("sees every room")}` : ""}
          </span>
        </div>
        <form className="flex items-end gap-2" onSubmit={saveName}>
          <div className="flex-1">
            <Field label={t("Name")}>
              <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button type="submit" variant="outline" disabled={name.trim() === me.name || !name.trim()}>
            {t("Save")}
          </Button>
        </form>
        <Note note={note} />
      </Section>

      <Section title={t("Appearance")}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("Language")}>
            <Select value={prefs.language} onValueChange={(v) => setPref({ language: v as Prefs["language"] })}>
              <SelectTrigger className="w-full" aria-label={t("Language")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LANGUAGES.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label={t("Theme")}>
            <ToggleGroup type="single" size="sm" value={prefs.theme} onValueChange={(v) => v && setPref({ theme: v as Prefs["theme"] })} aria-label={t("Theme")} className="justify-start">
              <ToggleGroupItem value="system">{t("System")}</ToggleGroupItem>
              <ToggleGroupItem value="light">{t("Light")}</ToggleGroupItem>
              <ToggleGroupItem value="dark">{t("Dark")}</ToggleGroupItem>
            </ToggleGroup>
          </Field>
        </div>
      </Section>
    </>
  );
}

// --- sign-in security -------------------------------------------------------------------

function Security({
  me,
  onMe,
  codes,
  onCodes,
}: {
  me: Member;
  onMe: (m: Member) => void;
  codes: string[] | null;
  onCodes: (codes: string[] | null) => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (err: unknown) => setNote({ ok: false, text: (err as Error).message });

  const savePassword = (e: FormEvent) => {
    e.preventDefault();
    api.changePassword(current, next).then(() => (setCurrent(""), setNext(""), setNote({ ok: true, text: t("Password changed. Other sessions were signed out.") })), fail);
  };

  return (
    <>
      <Section title={t("Password")}>
        <form className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end" onSubmit={savePassword}>
          <input type="email" hidden readOnly autoComplete="username" value={me.email ?? ""} />
          <Field label={t("Current password")}>
            <Input required type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </Field>
          <Field label={t("New password")}>
            <Input required type="password" minLength={10} autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline">
            {t("Change password")}
          </Button>
        </form>
        <Note note={note} />
      </Section>
      <TwoFactor me={me} onMe={onMe} codes={codes} onCodes={onCodes} />
    </>
  );
}

function TwoFactor({
  me,
  onMe,
  codes,
  onCodes,
}: {
  me: Member;
  onMe: (m: Member) => void;
  codes: string[] | null;
  onCodes: (codes: string[] | null) => void;
}) {
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [setupPassword, setSetupPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (err: unknown) => setNote({ ok: false, text: (err as Error).message });
  const startSetup = (e?: FormEvent) => {
    e?.preventDefault();
    api.totpSetup(needsPassword ? setupPassword : undefined).then(
      (value) => {
        setSetup(value);
        setSetupPassword("");
        setNeedsPassword(false);
        setNote(null);
      },
      (err) => {
        if (err instanceof ApiError && err.status === 403) setNeedsPassword(true);
        fail(err);
      },
    );
  };

  const enable = (e: FormEvent) => {
    e.preventDefault();
    api.totpEnable(code).then((r) => {
      onCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      setNote(null);
      api.me().then(onMe);
    }, fail);
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    api.totpDisable(password, code).then((m) => (onMe(m), setPassword(""), setCode(""), setNote({ ok: true, text: t("Two-factor sign-in is off.") })), fail);
  };
  const regenerate = () => {
    api.totpRegenerate(password, code).then((r) => {
      onCodes(r.recoveryCodes);
      setPassword("");
      setCode("");
      setNote(null);
      api.me().then(onMe);
    }, fail);
  };

  return (
    <Section
      title={t("Two-factor sign-in")}
      lead={t("Besides your password, sign-in asks for a code from an authenticator app (1Password, Google Authenticator, Aegis…).")}
    >
      {codes ? (
        <div className="flex flex-col gap-3">
          <p className="m-0 text-sm">{t("Two-factor sign-in is on. Save these recovery codes somewhere safe: each one signs you in once if you lose your phone.")}</p>
          <CopyField label={t("Recovery codes")} value={codes.join("\n")} multiline />
          <Button className="self-start" onClick={() => onCodes(null)}>
            {t("I saved them")}
          </Button>
        </div>
      ) : me.twoFactor ? (
        <form className="flex flex-col gap-3" onSubmit={disable}>
          <Quiet>
            {t("On.")} {plural(me.recoveryCodesLeft ?? 0, ["recovery code left", "recovery codes left"], ["záložní kód zbývá", "záložní kódy zbývají", "záložních kódů zbývá"])}
          </Quiet>
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <Field label={t("Password")}>
              <Input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label={t("Code or recovery code")}>
              <Input required autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button type="submit" variant="outline">
                {t("Turn off")}
              </Button>
              <Button type="button" variant="outline" disabled={!password || !code} onClick={regenerate}>
                {t("Generate new recovery codes")}
              </Button>
            </div>
          </div>
        </form>
      ) : setup ? (
        <form className="flex flex-col gap-4" onSubmit={enable}>
          <div className="flex flex-wrap items-start gap-6">
            <div
              className="size-44 shrink-0 rounded-lg bg-white p-2 [&_svg]:size-full"
              role="img"
              aria-label={t("QR code for your authenticator app")}
              dangerouslySetInnerHTML={{ __html: renderSVG(setup.uri, { border: 1 }) }}
            />
            <div className="flex min-w-0 flex-1 flex-col gap-3">
              <p className="m-0 text-sm">{t("Scan the code with your authenticator app, or type in the key.")}</p>
              <CopyField label={t("Key")} value={setup.secret} />
              <Field label={t("Code from the app")}>
                <Input required inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} />
              </Field>
              <div className="flex gap-2">
                <Button type="submit">{t("Turn on")}</Button>
                <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
                  {t("Cancel")}
                </Button>
              </div>
            </div>
          </div>
        </form>
      ) : needsPassword ? (
        <form className="flex max-w-sm flex-col gap-3" onSubmit={startSetup}>
          <Field label={t("Password")} hint={t("Enter your password again to continue.")}>
            <Input required type="password" autoComplete="current-password" value={setupPassword} onChange={(e) => setSetupPassword(e.target.value)} />
          </Field>
          <Button type="submit" variant="outline" className="self-start">
            {t("Continue")}
          </Button>
        </form>
      ) : (
        <Button variant="outline" className="self-start" onClick={() => startSetup()}>
          {t("Set up two-factor sign-in")}
        </Button>
      )}
      <Note note={note} />
    </Section>
  );
}

// --- safety ----------------------------------------------------------------------------

function Safety({ me, onMe, emailOn }: { me: Member; onMe: (m: Member) => void; emailOn: boolean }) {
  const prefs = me.prefs ?? DEFAULT_PREFS;
  const [keys, reloadKeys] = useLoad(() => api.approverKeys(), []);
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const fail = (err: unknown) => setNote({ ok: false, text: (err as Error).message });
  const setPref = (patch: Partial<Prefs>) => api.setPrefs(patch).then(onMe, fail);

  return (
    <>
      <Section
        title={t("Messages to your agents")}
        lead={t(
          "When someone from another company sends something that looks like an attack (asking for secrets, overriding instructions, shell payloads), Warren holds it. Your agents don't see it until you, their owner, release it.",
        )}
      >
        <Switch
          checked={prefs.holdAllForeign}
          onChange={(v) => setPref({ holdAllForeign: v })}
          label={t("Hold every message from another company")}
          hint={t("Strict mode: even harmless-looking messages from other companies wait for you before your agents get them.")}
        />
        <Switch
          checked={prefs.emailOnHold}
          onChange={(v) => setPref({ emailOnHold: v })}
          label={t("Email me when a message waits for me")}
          hint={emailOn ? undefined : t("This hub has no email set up, so you'll only see it in the app.")}
        />
        <Note note={note} />
      </Section>

      <Section
        title={t("Approve from your agent's session")}
        lead={t(
          "Put an approver key next to your agent and Warren asks you right there: Claude Code shows you a dialog your agent can't see, the Codex and Cursor bridge asks in its terminal. The key can only decide for your own agents.",
        )}
      >
        {created ? (
          <div className="flex flex-col gap-3">
            <CopyField label={t("Approver key (shown once)")} value={created} />
            <CopyField label={t("Add it to the bridge's env in .mcp.json")} value={`"WARREN_APPROVER_KEY": "${created}"`} />
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">
              {t("The key sits on the same machine as your agent. If your agent runs with unrestricted shell access, it could read it: approve in the app instead.")}
            </p>
            <Button className="self-start" onClick={() => setCreated(null)}>
              {t("Done")}
            </Button>
          </div>
        ) : (
          <form
            className="flex items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              api.addApproverKey(label || t("my laptop")).then((r) => (setCreated(r.key), setLabel(""), reloadKeys()), fail);
            }}
          >
            <div className="flex-1">
              <Field label={t("Where it will live")}>
                <Input value={label} maxLength={60} onChange={(e) => setLabel(e.target.value)} placeholder={t("my laptop")} />
              </Field>
            </div>
            <Button type="submit" variant="outline">
              {t("Create key")}
            </Button>
          </form>
        )}
        {keys.status === "loading" && <Quiet>{t("Loading approver keys…")}</Quiet>}
        {keys.status === "error" && (
          <LoadError message={t("Couldn't load approver keys.")} error={keys.error} retry={reloadKeys} />
        )}
        {keys.status === "data" && keys.data.length === 0 && <Quiet>{t("No approver keys yet.")}</Quiet>}
        {keys.status === "data" && keys.data.length > 0 && (
          <ul className="flex flex-col gap-1">
            {keys.data.map((k: ApproverKey) => (
              <li key={k.id} className="flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/40">
                <div className="min-w-0 flex-1 text-sm">
                  <div className="truncate font-medium">{k.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("created {date}", { date: formatDate(k.createdAt, { day: "numeric", month: "short" }) })}
                    {k.lastUsedAt ? ` · ${t("last used {date}", { date: formatDate(k.lastUsedAt, { day: "numeric", month: "short" }) })}` : ""}
                  </div>
                </div>
                <Button size="xs" variant="ghost" className="text-destructive" onClick={() => api.removeApproverKey(k.id).then(reloadKeys)}>
                  {t("Revoke")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}

// --- privacy ---------------------------------------------------------------------------

function Privacy({ me, config, onMe }: { me: Member; config: HubConfig; onMe: (m: Member | null) => void }) {
  const [password, setPassword] = useState("");
  const [withMessages, setWithMessages] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const download = async () => {
    setDownloading(true);
    try {
      const data = await api.exportMe();
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "warren-data.json";
      link.hidden = true;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setNote(null);
    } catch (error) {
      setNote({ ok: false, text: (error as Error).message });
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <Section
        title={t("Your data")}
        lead={
          <>
            {t("This hub stores your name, email, company, password hash, your messages and your agents' messages, and a safety log. It sets one cookie, to keep you signed in.")}{" "}
            {config.retentionDays ? t("Messages are deleted after {days} days.", { days: config.retentionDays }) : t("Messages are kept until someone deletes them.")}{" "}
            <a href="/privacy" target="_blank" rel="noreferrer">
              {t("Privacy notice")}
            </a>
          </>
        }
      >
        <Button variant="outline" className="self-start" disabled={downloading} onClick={download}>
          {downloading ? t("Preparing download…") : t("Download my data")}
        </Button>
        <Note note={note} />
      </Section>

      <Section
        title={t("Delete my account")}
        lead={t("Your name, email, password and keys are deleted and your agents removed. Your handle stays reserved so old threads still read, signed “Former member”.")}
      >
        {me.role === "owner" ? (
          <Quiet>{t("You own this hub. Hand over ownership in People first.")}</Quiet>
        ) : confirm ? (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              api.deleteMe(password, withMessages).then(() => onMe(null), (err) => setNote({ ok: false, text: (err as Error).message }));
            }}
          >
            <Switch checked={withMessages} onChange={setWithMessages} label={t("Also delete everything I and my agents wrote")} />
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <Field label={t("Password")}>
                  <Input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
                </Field>
              </div>
              <Button type="submit" variant="destructive">
                {t("Delete for good")}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setConfirm(false)}>
                {t("Keep it")}
              </Button>
            </div>
          </form>
        ) : (
          <Button variant="ghost" className="-ml-2.5 self-start text-destructive" onClick={() => setConfirm(true)}>
            {t("Delete my account")}
          </Button>
        )}
        <Note note={note} />
      </Section>
    </>
  );
}

// --- people and invites -------------------------------------------------------------------

function People({ me, config, rooms, members }: { me: Member; config: HubConfig; rooms: Record<string, Room>; members: Record<string, Member> }) {
  const admin = isAdmin(me);
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.scopeRoomId}${m.role}`)
    .join(",");
  const [users, reloadUsers] = useLoad(() => (admin ? api.users() : Promise.resolve([] as User[])), [admin, memberState]);
  const [invites, reloadInvites] = useLoad(() => api.invites(), [admin]);
  const [inviting, setInviting] = useState(false);
  const inviteButton = (
    <Button size="sm" onClick={() => setInviting(true)}>
      <PlusIcon data-icon="inline-start" weight="bold" />
      {t("Invite a person")}
    </Button>
  );

  return (
    <>
      {admin && (
        <Section title={t("People")} action={inviteButton}>
          {users.status === "loading" ? (
            <Quiet>{t("Loading people…")}</Quiet>
          ) : users.status === "error" ? (
            <LoadError message={t("Couldn't load people.")} error={users.error} retry={reloadUsers} />
          ) : (
            <ul className="flex flex-col gap-1">
              {users.data.map((u) => (
                <UserRow key={u.handle} u={u} me={me} rooms={rooms} onChanged={reloadUsers} />
              ))}
            </ul>
          )}
        </Section>
      )}
      <Section title={admin ? t("Pending invites") : t("Invites you sent")} action={!admin && inviteButton}>
        {invites.status === "loading" ? (
          <Quiet>{t("Loading invites…")}</Quiet>
        ) : invites.status === "error" ? (
          <LoadError message={t("Couldn't load invites.")} error={invites.error} retry={reloadInvites} />
        ) : invites.data.length ? (
          <ul className="flex flex-col gap-1">
            {invites.data.map((i) => (
              <InviteRow key={i.id} i={i} onRevoked={reloadInvites} />
            ))}
          </ul>
        ) : (
          <Quiet>{t("No open invites. Links you create show up here until someone uses them.")}</Quiet>
        )}
      </Section>
      <InviteDialog open={inviting} onOpenChange={setInviting} me={me} rooms={rooms} room={null} emailOn={config.email} onInvited={reloadInvites} />
    </>
  );
}

function UserRow({ u, me, rooms, onChanged }: { u: User; me: Member; rooms: Record<string, Room>; onChanged: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [reset, setReset] = useState<{ url: string; emailed: boolean } | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [demoting, setDemoting] = useState(false);
  const [demotionRoom, setDemotionRoom] = useState<string | null>(null);
  const isOwner = u.role === "owner";
  const isMe = u.handle === me.handle;
  const canEdit = !isMe && (!isOwner || me.role === "owner");
  const act = (p: Promise<unknown>) => p.then(onChanged, (e) => setError((e as Error).message));
  const changeRole = (role: Role) => {
    setError(null);
    if (role === "member") {
      setDemotionRoom(null);
      setDemoting(true);
      return;
    }
    setDemoting(false);
    act(api.updateUser(u.handle, { role }));
  };
  const demote = () => {
    if (!demotionRoom) return;
    api.updateUser(u.handle, { role: "member", room: demotionRoom }).then(
      () => {
        setDemoting(false);
        onChanged();
      },
      (e) => setError((e as Error).message),
    );
  };

  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar kind="human" name={u.name} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">
            {u.name}
            {isMe && <span className="ml-1.5 text-xs font-medium text-primary">{t("you")}</span>}
          </div>
          <div className="truncate text-xs text-muted-foreground">
            @{u.handle} · {u.email ?? t("no email")} · {u.org}
            {u.twoFactor ? ` · ${t("2FA")}` : ""}
            {u.agents ? ` · ${plural(u.agents, ["agent", "agents"], ["agent", "agenti", "agentů"])}` : ""}
          </div>
        </div>
        {canEdit && !isOwner ? (
          <Select
            value={u.role ?? "member"}
            onValueChange={(role) => changeRole(role as Role)}
          >
            <SelectTrigger size="sm" className="w-28" aria-label={t("Role of {name}", { name: u.name })}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {me.role === "owner" && <SelectItem value="owner">{t("Owner")}</SelectItem>}
              <SelectItem value="admin">{t("Admin")}</SelectItem>
              <SelectItem value="member">{t("Member")}</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <span className="w-28 px-2 text-xs text-muted-foreground">{roleLabel(u.role)}</span>
        )}
      </div>
      {demoting && (
        <div className="flex flex-col gap-2 pl-[42px]">
          <p className="m-0 text-xs text-muted-foreground">{t("Choose the room this member can see before changing their role.")}</p>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-64">
              <RoomSelect rooms={rooms} value={demotionRoom} onChange={setDemotionRoom} label={t("Room for {name}", { name: u.name })} />
            </div>
            <Button size="xs" disabled={!demotionRoom} onClick={demote}>
              {t("Change to member")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setDemoting(false)}>
              {t("Cancel")}
            </Button>
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 pl-[42px]">
        {u.role === "member" && canEdit ? (
          <div className="w-64">
            <RoomSelect rooms={rooms} value={u.scopeRoomId} onChange={(room) => room && act(api.updateUser(u.handle, { room }))} label={t("What {name} sees", { name: u.name })} />
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">{t("Sees {where}", { where: roomPath(u.scopeRoomId, rooms) })}</span>
        )}
        {canEdit && (
          <>
            <Button size="xs" variant="ghost" onClick={() => api.resetLink(u.handle).then(setReset, (e) => setError((e as Error).message))}>
              {t("Password reset link")}
            </Button>
            {confirm ? (
              <>
                <Button size="xs" variant="destructive" onClick={() => act(api.removeUser(u.handle))}>
                  {t("Remove {name} and their agents", { name: u.name })}
                </Button>
                <Button size="xs" variant="ghost" onClick={() => setConfirm(false)}>
                  {t("Keep")}
                </Button>
              </>
            ) : (
              <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirm(true)}>
                {t("Remove")}
              </Button>
            )}
          </>
        )}
      </div>
      {reset && (
        <div className="pl-[42px]">
          <CopyField label={reset.emailed ? t("Emailed to {email}; valid for a day", { email: u.email ?? "" }) : t("Send this to them; it works once, for a day")} value={reset.url} />
        </div>
      )}
      {error && <p className="error pl-[42px]">{error}</p>}
    </li>
  );
}

function InviteRow({ i, onRevoked }: { i: Invite; onRevoked: () => void }) {
  const until = formatDate(i.expiresAt, { day: "numeric", month: "short" });
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg px-2 py-2.5 hover:bg-muted/40">
      <div className="min-w-0 flex-1 text-sm">
        <div className="truncate font-medium">{i.email ?? t("Anyone with the link")}</div>
        <div className="truncate text-xs text-muted-foreground">
          {i.org} · {i.role === "admin" ? t("admin, every room") : (i.roomName ?? i.room)} · {t("by")} @{i.invitedBy ?? "admin"} · {t("until {date}", { date: until })}
        </div>
      </div>
      <Button size="xs" variant="ghost" onClick={() => api.revokeInvite(i.id).then(onRevoked)}>
        {t("Revoke")}
      </Button>
    </li>
  );
}

// --- agents ---------------------------------------------------------------------------

function Agents({ me, rooms, members }: { me: Member; rooms: Record<string, Room>; members: Record<string, Member> }) {
  const memberState = Object.values(members)
    .map((m) => `${m.handle}:${m.online ? 1 : 0}${m.paused ? 1 : 0}${m.scopeRoomId}`)
    .join(",");
  const [agents, reload] = useLoad(() => api.agents(), [memberState]);
  const [adding, setAdding] = useState(false);
  const [rotated, setRotated] = useState<NewAgent | null>(null);
  return (
    <Section
      title={isAdmin(me) ? t("Agents") : t("Your agents")}
      lead={t("Each agent gets its own token and sees one room and the rooms inside it. It belongs to you and your company; you pause it, and you approve what other companies send it.")}
      action={
        <Button size="sm" onClick={() => setAdding(true)}>
          <PlusIcon data-icon="inline-start" weight="bold" />
          {t("Add an agent")}
        </Button>
      }
    >
      {agents.status === "loading" ? (
        <Quiet>{t("Loading agents…")}</Quiet>
      ) : agents.status === "error" ? (
        <LoadError message={t("Couldn't load agents.")} error={agents.error} retry={reload} />
      ) : agents.data.length ? (
        <ul className="flex flex-col gap-1">
          {agents.data.map((a) => (
            <AgentRow key={a.handle} a={a} rooms={rooms} members={members} onRotated={setRotated} onChanged={reload} />
          ))}
        </ul>
      ) : (
        <Quiet>{t("No agents yet. Add one and paste its setup into Claude Code, Codex or Cursor.")}</Quiet>
      )}
      <AgentDialog open={adding} onOpenChange={setAdding} me={me} rooms={rooms} room={null} onAdded={reload} />
      <AgentDialog open={!!rotated} onOpenChange={(o) => !o && setRotated(null)} me={me} rooms={rooms} room={null} existing={rotated} />
    </Section>
  );
}

const adapterLabel = (a: Member["adapter"]) =>
  ({
    channel: t("pushed into its session"),
    exec: t("woken on mention"),
    inbox: t("reads its inbox"),
    a2a: "A2A",
    dashboard: t("dashboard"),
  })[a];

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
  const owner = a.owner ? (members[a.owner]?.name ?? `@${a.owner}`) : t("nobody");
  const fail = (e: unknown) => setError((e as Error).message);
  return (
    <li className="flex flex-col gap-2 rounded-lg px-2 py-3 hover:bg-muted/40">
      <div className="flex flex-wrap items-center gap-3">
        <Avatar kind="agent" name={a.name} size={30} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{a.name}</div>
          <div className="truncate text-xs text-muted-foreground">
            @{a.handle} · {a.org} · {t("owner {name}", { name: owner })} · {adapterLabel(a.adapter)}
            {a.paused ? ` · ${t("paused")}` : a.online ? ` · ${t("online")}` : ` · ${t("offline")}`}
          </div>
        </div>
        <div className="w-56">
          <RoomSelect rooms={rooms} value={a.scopeRoomId} onChange={(room) => room && api.updateAgent(a.handle, { room }).then(onChanged, fail)} label={t("What {name} sees", { name: a.name })} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2 pl-[42px]">
        {confirm === "token" ? (
          <>
            <Button size="xs" onClick={() => api.rotateAgent(a.handle).then((r) => (setConfirm(null), onRotated(r)), fail)}>
              {t("Replace token")}
            </Button>
            <span className="self-center text-xs text-muted-foreground">{t("The running agent loses access until you paste the new one.")}</span>
            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
              {t("Cancel")}
            </Button>
          </>
        ) : confirm === "remove" ? (
          <>
            <Button size="xs" variant="destructive" onClick={() => api.removeAgent(a.handle).then(onChanged, fail)}>
              {t("Remove @{handle}", { handle: a.handle })}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirm(null)}>
              {t("Keep")}
            </Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="ghost" onClick={() => setConfirm("token")}>
              {t("New token")}
            </Button>
            <Button size="xs" variant="ghost" className="text-destructive" onClick={() => setConfirm("remove")}>
              {t("Remove")}
            </Button>
          </>
        )}
      </div>
      {error && <p className="error pl-[42px]">{error}</p>}
    </li>
  );
}

// --- hub settings (owners and admins) ----------------------------------------------------

function Hub({ config, onConfig }: { config: HubConfig; onConfig: (c: Partial<HubConfig>) => void }) {
  const [name, setName] = useState(config.instanceName);
  const [days, setDays] = useState(String(config.retentionDays || ""));
  const [contact, setContact] = useState(config.privacyContact);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const save = (e: FormEvent) => {
    e.preventDefault();
    api.setInstance({ name, retentionDays: Number(days) || 0, privacyContact: contact }).then(
      (r) => (onConfig({ instanceName: r.instanceName, retentionDays: r.retentionDays, privacyContact: r.privacyContact }), setNote({ ok: true, text: t("Saved.") })),
      (err) => setNote({ ok: false, text: (err as Error).message }),
    );
  };
  return (
    <Section title={t("This hub")} lead={t("You run this hub, so you decide how long it keeps messages and who people contact about their data.")}>
      <form className="flex flex-col gap-4" onSubmit={save}>
        <Field label={t("Name")}>
          <Input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("Delete messages after (days)")} hint={t("Empty or 0 keeps them. Older messages are deleted every hour; the safety log stays.")}>
          <Input inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value.replace(/\D/g, ""))} placeholder="0" />
        </Field>
        <Field label={t("Privacy contact")} hint={t("Shown in the privacy notice: who people write to about their data (an email or a web page).")}>
          <Input value={contact} maxLength={200} onChange={(e) => setContact(e.target.value)} placeholder="privacy@example.com" />
        </Field>
        <Button type="submit" className="self-start">
          {t("Save")}
        </Button>
        <Note note={note} />
      </form>
    </Section>
  );
}
