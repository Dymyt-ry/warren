// Screens before the dashboard: first-run owner setup, sign-in, accepting an
// invite, and setting a new password from a reset link. One quiet column on
// the canvas, no cards (web/DESIGN.md).
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Logo } from "./Logo";
import { t } from "./i18n";
import { api, ApiError, type HubConfig, type Member } from "./api";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-foreground">{label}</span>
      {children}
      {hint && <span className="text-xs leading-snug text-muted-foreground">{hint}</span>}
    </label>
  );
}

function Screen({ title, lead, children }: { title: string; lead?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10 md:py-16">
      <div className="flex w-full max-w-[400px] flex-col gap-8">
        <Logo />
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-2xl md:text-[28px]">{title}</h1>
          {lead && <p className="m-0 text-[15px] leading-relaxed text-muted-foreground">{lead}</p>}
        </div>
        {children}
      </div>
    </div>
  );
}

/** A form that shows the hub's error under the button and disables itself while sending. */
function useSubmit(action: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, onSubmit };
}

const PASSWORD_HINT = "At least 10 characters. A few words in a row work well.";

export function SetupScreen({ config, onDone }: { config: HubConfig; onDone: (m: Member) => void }) {
  const [f, setF] = useState({ name: "", org: "", email: "", password: "", room: "", setupToken: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { busy, error, onSubmit } = useSubmit(async () =>
    onDone(await api.setup({ ...f, room: f.room || f.org, instanceName: f.org, setupToken: f.setupToken || undefined })),
  );
  return (
    <Screen
      title={t("Set up your hub")}
      lead={t("You're the first one here, so you become its owner. You'll invite your team, other companies and their agents next.")}
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <Field label={t("Your name")}>
          <Input className="h-10" required autoFocus autoComplete="name" value={f.name} onChange={set("name")} />
        </Field>
        <Field label={t("Your company")} hint={t("People and agents of other companies show up as guests next to this name.")}>
          <Input className="h-10" required autoComplete="organization" value={f.org} onChange={set("org")} />
        </Field>
        <Field label={t("Email")}>
          <Input className="h-10" required type="email" autoComplete="email" value={f.email} onChange={set("email")} />
        </Field>
        <Field label={t("Password")} hint={PASSWORD_HINT}>
          <Input className="h-10" required type="password" minLength={10} autoComplete="new-password" value={f.password} onChange={set("password")} />
        </Field>
        <Field label={t("First room")} hint={t("The top of your tree, usually a product or a client. Leave empty to name it after your company.")}>
          <Input className="h-10" placeholder={f.org || "shop"} value={f.room} onChange={set("room")} />
        </Field>
        {config.setupToken && (
          <Field label={t("Setup token")} hint={t("Set in the hub's environment as WARREN_SETUP_TOKEN.")}>
            <Input className="h-10" required type="password" value={f.setupToken} onChange={set("setupToken")} />
          </Field>
        )}
        {error && <p className="error">{error}</p>}
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? "Creating your account" : "Create owner account"}
        </Button>
      </form>
    </Screen>
  );
}

export function SignInScreen({ config, onDone }: { config: HubConfig; onDone: (m: Member) => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const { busy, error, onSubmit } = useSubmit(async () => {
    try {
      onDone(await api.signIn(email, password, code || undefined));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && /code/i.test(e.message)) setNeedCode(true);
      throw e;
    }
  });
  return (
    <Screen title={`Sign in to ${config.instanceName}`}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <Field label={t("Email")}>
          <Input className="h-10" required autoFocus type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label={t("Password")}>
          <Input className="h-10" required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {needCode && (
          <Field label={t("Code from your authenticator app")} hint={t("Or one of your recovery codes.")}>
            <Input className="h-10" required autoFocus autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
          </Field>
        )}
        {error && <p className="error">{error}</p>}
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? "Signing in" : "Sign in"}
        </Button>
        <p className="m-0 text-xs leading-relaxed text-muted-foreground">
          Forgot your password? Ask an admin of this hub for a reset link. The owner can make one on the server with{" "}
          <code className="font-mono">npm run warren -- reset-password you@example.com</code>.
        </p>
      </form>
    </Screen>
  );
}

type JoinInfo = Awaited<ReturnType<typeof api.joinInfo>>;

export function JoinScreen({ code, onDone }: { code: string; onDone: (m: Member) => void }) {
  const [info, setInfo] = useState<JoinInfo | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", email: "", password: "" });
  useEffect(() => {
    api.joinInfo(code).then(setInfo, (e) => setGone((e as Error).message));
  }, [code]);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  const { busy, error, onSubmit } = useSubmit(async () =>
    onDone(await api.join(code, { name: f.name, password: f.password, email: info?.email ? undefined : f.email })),
  );

  if (gone) return <Screen title={t("This invite doesn't work anymore")} lead={`${gone[0].toUpperCase()}${gone.slice(1)}. Ask whoever sent it for a new one.`}>{null}</Screen>;
  if (!info) return <Screen title={t("Opening your invite")}>{null}</Screen>;
  const where = info.role === "admin" ? "as an admin, with access to every room" : info.room ? `to ${info.room}` : "";
  return (
    <Screen
      title={`Join ${info.instanceName}`}
      lead={
        <>
          {info.invitedBy ?? "An admin"} invited you {where}, as part of <span className="font-medium text-foreground">{info.org}</span>.
          You'll see that room and the rooms inside it, and can add your own agents there.
        </>
      }
    >
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <Field label={t("Your name")}>
          <Input className="h-10" required autoFocus autoComplete="name" value={f.name} onChange={set("name")} />
        </Field>
        <Field label={t("Email")}>
          {info.email ? (
            <Input className="h-10" disabled value={info.email} />
          ) : (
            <Input className="h-10" required type="email" autoComplete="email" value={f.email} onChange={set("email")} />
          )}
        </Field>
        <Field label={t("Password")} hint={PASSWORD_HINT}>
          <Input className="h-10" required type="password" minLength={10} autoComplete="new-password" value={f.password} onChange={set("password")} />
        </Field>
        {error && <p className="error">{error}</p>}
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? "Joining" : "Join"}
        </Button>
      </form>
    </Screen>
  );
}

export function ResetScreen({ code, onDone }: { code: string; onDone: (m: Member | null) => void }) {
  const [info, setInfo] = useState<{ instanceName: string; email: string; name: string; twoFactor: boolean } | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [requiresLogin, setRequiresLogin] = useState(false);
  useEffect(() => {
    api.resetInfo(code).then(setInfo, (e) => setGone((e as Error).message));
  }, [code]);
  const { busy, error, onSubmit } = useSubmit(async () => {
    const result = await api.reset(code, password);
    if ("requiresLogin" in result) setRequiresLogin(true);
    else onDone(result);
  });

  if (gone) return <Screen title={t("This link doesn't work anymore")} lead={t("Reset links work once and for a day. Ask an admin for a new one.")}>{null}</Screen>;
  if (!info) return <Screen title={t("Opening your link")}>{null}</Screen>;
  if (requiresLogin)
    return (
      <Screen title={t("Password changed")} lead={t("Sign in with your new password and a code from your authenticator app.")}>
        <Button size="lg" className="h-10" onClick={() => onDone(null)}>
          {t("Continue to sign in")}
        </Button>
      </Screen>
    );
  return (
    <Screen title={t("Set a new password")} lead={`For ${info.email} on ${info.instanceName}. You'll be signed out everywhere else.`}>
      <form className="flex flex-col gap-5" onSubmit={onSubmit}>
        <input type="email" hidden readOnly autoComplete="username" value={info.email} />
        <Field label={t("New password")} hint={PASSWORD_HINT}>
          <Input className="h-10" required autoFocus type="password" minLength={10} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        {error && <p className="error">{error}</p>}
        <Button type="submit" size="lg" className="h-10" disabled={busy}>
          {busy ? "Saving" : info.twoFactor ? t("Save password") : t("Save and sign in")}
        </Button>
      </form>
    </Screen>
  );
}
