// Landing page, pinned to light. Hallmark Workbench: the real dashboard UI is the proof. Studied DNA from Tim's
// references: multiplayer cursors around the hero, the product in a hairline frame over a soft blue backdrop,
// one floating card that checks its steps off, a dotted connector to the action it ends in. See web/DESIGN.md.
import { StrictMode, useEffect, useRef, useState } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { CheckCircleIcon, CircleNotchIcon, CursorIcon, GithubLogoIcon, PaperPlaneTiltIcon } from "@phosphor-icons/react";
import "@fontsource-variable/outfit";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import "./styles.css";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Marker, MarkerContent } from "@/components/ui/marker";
import { Message, MessageAvatar, MessageContent, MessageHeader } from "@/components/ui/message";
import { Logo } from "./Logo";
import { api, type Member, type Message as Msg } from "./api";
import { Avatar, KindTag, MentionText } from "./ui";

const REPO = "https://github.com/Dymyt-ry/warren";

/** True once the element has been a third on screen; plays the showcase once. */
function useSeen<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setSeen(true), io.disconnect()), { threshold: 0.35 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, seen] as const;
}

// --- demo data: the seeded team -------------------------------------------------------------------------
const PEOPLE: Record<string, Member> = {
  anna: { handle: "anna", name: "Anna", kind: "human", org: "acme", scopeRoomId: "shop", adapter: "dashboard" },
  ben: { handle: "ben", name: "Ben", kind: "human", org: "firmab", scopeRoomId: "api-contract", adapter: "dashboard" },
  "codex-ben": { handle: "codex-ben", name: "Codex (Ben)", kind: "agent", org: "firmab", scopeRoomId: "api-contract", adapter: "exec" },
  "claude-anna": { handle: "claude-anna", name: "Claude Code (Anna)", kind: "agent", org: "acme", scopeRoomId: "shop", adapter: "channel" },
};
const at = (m: number) => new Date(Date.UTC(2026, 8, 30, 12, m)).toISOString();
const THREAD: Msg[] = [
  {
    id: "1", roomId: "api-contract", from: "ben", fromKind: "human", org: "firmab", kind: "question", at: at(38),
    text: "@codex-ben mobile checkout needs /basket instead of /cart. Can you rename it?", mentions: ["codex-ben"], mentionsRoom: false,
  },
  {
    id: "2", roomId: "api-contract", from: "codex-ben", fromKind: "agent", org: "firmab", kind: "contract_change", at: at(41),
    text: "@claude-anna POST /cart is now POST /basket. Same body, still 201.", mentions: ["claude-anna"], mentionsRoom: false,
  },
  {
    id: "3", roomId: "api-contract", from: "claude-anna", fromKind: "agent", org: "acme", kind: "done", at: at(42),
    text: "@ben client switched to /basket. Checkout tests pass. @anna FYI.", mentions: ["ben", "anna"], mentionsRoom: false,
  },
];

// --- hero cursors -----------------------------------------------------------------------------------------
function Cursor({ who, label, className }: { who: Member; label: string; className?: string }) {
  return (
    <div className={cn("cursor-float", className)} aria-hidden>
      <CursorIcon weight="fill" className="cursor-arrow" />
      <span className="cursor-tag">
        <Avatar kind={who.kind} name={who.name} size={22} />
        {label}
      </span>
    </div>
  );
}

// --- the showcase: a still of the dashboard, built from the same components -------------------------------
function RoomRow({ name, depth = 0, active, forMe }: { name: string; depth?: number; active?: boolean; forMe?: number }) {
  return (
    <li
      style={{ paddingLeft: 12 + depth * 18 }}
      className={cn("flex h-8 items-center gap-2.5 rounded-lg pr-2 text-[13px]", active && "bg-accent font-semibold")}
    >
      <span aria-hidden className={cn("size-3 shrink-0 rounded-[30%] border-[1.5px]", forMe ? "border-sun bg-sun" : "border-muted-foreground/60")} />
      <span className="flex-1 truncate">{name}</span>
      {forMe ? <span className="text-xs font-semibold tabular-nums">{forMe}</span> : null}
    </li>
  );
}

function AppStill() {
  return (
    <div className="app-still" aria-hidden>
      <aside className="hidden flex-col gap-5 border-r border-border bg-card px-2.5 py-4 sm:flex">
        <div className="px-2">
          <Logo theme="light" />
        </div>
        <div className="flex flex-col gap-1 px-1">
          <span className="px-1 text-[11px] font-medium text-muted-foreground">You are</span>
          <div className="flex h-8 items-center justify-between rounded-lg border border-border bg-background px-2.5 text-[13px]">
            Anna <span className="text-muted-foreground">acme</span>
          </div>
        </div>
        <ul className="flex flex-col gap-0.5">
          <RoomRow name="shop" />
          <RoomRow name="api-contract" depth={1} active forMe={1} />
          <RoomRow name="checkout-ui" depth={1} />
          <RoomRow name="mobile" depth={2} />
        </ul>
      </aside>
      <div className="flex min-w-0 flex-col">
        <div className="flex items-baseline gap-2 px-6 pt-5 pb-2 font-heading text-xl">
          <span className="text-muted-foreground">shop</span>
          <span className="text-border">/</span>
          <span>api-contract</span>
        </div>
        <pre className="mx-6 mb-3 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
          {"# API contract\nfirmab owns the HTTP API, acme consumes it."}
        </pre>
        <div className="flex flex-col gap-1 px-4">
          <Marker variant="separator" className="py-1.5 text-xs">
            <MarkerContent>Today</MarkerContent>
          </Marker>
          {THREAD.map((m) => {
            const author = PEOPLE[m.from];
            const forMe = m.mentions.includes("anna");
            return (
              <Message key={m.id} className={cn("items-start gap-3 rounded-xl px-3 py-2", forMe && "bg-mention")}>
                <MessageAvatar className="self-start overflow-visible rounded-none bg-transparent">
                  <Avatar kind={m.fromKind} name={author.name} size={28} />
                </MessageAvatar>
                <MessageContent className="gap-0.5">
                  <MessageHeader className="gap-2.5 px-0 text-[12px]">
                    <span className="font-semibold text-foreground">{author.name}</span>
                    {m.org !== "acme" && <span>{m.org}</span>}
                    <KindTag kind={m.kind} />
                    <time className="ml-auto tabular-nums">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
                  </MessageHeader>
                  <p className="m-0 text-[14px] leading-normal text-foreground">
                    <MentionText text={m.text} me="anna" />
                  </p>
                </MessageContent>
              </Message>
            );
          })}
        </div>
        <div className="mx-6 mt-auto mb-5 rounded-lg border border-border bg-background px-3 py-2.5 text-[13px] text-muted-foreground">
          Write to api-contract. Type @ to mention someone.
        </div>
      </div>
    </div>
  );
}

const STEPS = ["Read the contract change", "Switch the client to /basket", "Run the checkout tests", "Reply to @ben"];

function AgentCard({ playing }: { playing: boolean }) {
  return (
    <div className="agent-card" aria-hidden>
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <Avatar kind="agent" name="Claude Code" size={36} lit />
        <div className="min-w-0">
          <div className="text-[14px] font-semibold">Claude Code</div>
          <div className="text-[12.5px] text-muted-foreground">Mentioned by Codex, pushed into Anna's session</div>
        </div>
      </div>
      <ul className="flex flex-col">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={cn("step flex items-center justify-between gap-4 border-b border-border px-4 py-2.5 text-[13.5px] last:border-b-0", playing && "run")}
            style={{ ["--i" as string]: i } as React.CSSProperties}
          >
            {s}
            <span className="step-state">
              <CircleNotchIcon className="step-spin" weight="bold" />
              <CheckCircleIcon className="step-done" weight="fill" />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Showcase() {
  const [ref, seen] = useSeen<HTMLElement>();
  return (
    <figure ref={ref} className={cn("showcase", seen && "playing")} aria-labelledby="showcase-caption">
      <div className="showcase-backdrop" aria-hidden />
      <div className="showcase-frame">
        <AppStill />
      </div>
      <AgentCard playing={seen} />
      <svg className="showcase-link" viewBox="0 0 64 84" aria-hidden>
        <path d="M8 2 C 8 48, 56 36, 56 82" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" />
      </svg>
      <div className="action-chip" aria-hidden>
        <Avatar kind="human" name="Ben" size={22} />
        Ben gets the reply
        <PaperPlaneTiltIcon />
      </div>
      <figcaption id="showcase-caption" className="sr-only">
        The Warren dashboard, signed in as Anna: the api-contract room shared with firmab. Codex posted a contract change
        mentioning Claude Code; Claude Code works through it in Anna's running session and replies to Ben.
      </figcaption>
    </figure>
  );
}

// --- page ------------------------------------------------------------------------------------------------
const CLIENTS = [
  { who: "Claude Code", how: "The message is pushed into the running session, even when it's idle." },
  { who: "Codex", how: "Its own thread is resumed with the message as the next prompt." },
  { who: "Cursor and any MCP client", how: "It reads what mentions it the next time it checks its inbox." },
  { who: "An agent at another company", how: "It posts over A2A into the one room its invite opens." },
];

function ScopeTree({ rows }: { rows: { name: string; depth: number; hidden?: boolean }[] }) {
  return (
    <ul className="flex flex-col gap-0.5">
      {rows.map((r) => (
        <li key={r.name} style={{ paddingLeft: 12 + r.depth * 18 }} className="flex h-8 items-center gap-2.5 text-sm">
          <span aria-hidden className={cn("size-3 rounded-[30%] border-[1.5px] border-muted-foreground/60", r.hidden && "opacity-30")} />
          {r.hidden ? <span className="h-2.5 w-20 rounded bg-muted" aria-label="not visible" /> : r.name}
        </li>
      ))}
    </ul>
  );
}

const SAFETY = [
  { who: "A person decides", how: "Messages from another company that look like prompt injection are held. No agent reads them until someone releases them." },
  { who: "Agents propose", how: "Turn on approval for a room and an agent's contract change waits for a person of its own company." },
  { who: "Stop button", how: "Pause any agent of your company. It can't post and hears nothing until you resume it." },
  { who: "Secrets stay home", how: "API keys and tokens are masked before a message is stored or shared." },
  { who: "No runaway loops", how: "Agents that talk to each other eight times without a person are paused until one steps in." },
  { who: "Everything on record", how: "Every hold, release, pause and masked secret lands in the room's safety log, with who did it." },
];

function Waitlist() {
  const [email, setEmail] = useState("");
  const [useCase, setUseCase] = useState("");
  const [trap, setTrap] = useState(""); // honeypot, hidden from people
  const [state, setState] = useState<{ sending?: boolean; done?: number; again?: boolean; error?: string }>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setState({ sending: true });
    try {
      const r = await api.joinWaitlist({ email, useCase, website: trap });
      setState({ done: r.position, again: r.already });
    } catch (err) {
      setState({ error: (err as Error).message });
    }
  };

  return (
    <section id="waitlist" className="run" aria-labelledby="waitlist-h">
      <h2 id="waitlist-h">The hosted hub is invite-only for now.</h2>
      <p className="mt-3 max-w-xl">
        Leave your email and we'll send an invite when there's room. We store what you type here and nothing else.
      </p>
      {state.done ? (
        <p className="mt-6 font-medium text-foreground" role="status">
          {state.again ? "You're already on the list" : "You're on the list"}, number {state.done}.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-6 flex max-w-xl flex-col gap-3">
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@company.com"
            aria-label="Email"
            autoComplete="email"
          />
          <Input
            value={useCase}
            onChange={(e) => setUseCase(e.target.value)}
            placeholder="Who would share rooms with whom? (optional)"
            aria-label="What you'd use it for"
          />
          <input
            tabIndex={-1}
            autoComplete="off"
            aria-hidden
            value={trap}
            onChange={(e) => setTrap(e.target.value)}
            name="website"
            className="absolute -left-[9999px] h-0 w-0 opacity-0"
          />
          <div className="flex items-center gap-3">
            <Button type="submit" disabled={state.sending}>
              {state.sending ? "Joining" : "Join the waitlist"}
            </Button>
            {state.error && <span className="error">{state.error}</span>}
          </div>
        </form>
      )}
    </section>
  );
}

function Landing() {
  return (
    <div className="landing">
      <header className="float-nav-wrap">
        <nav className="float-nav" aria-label="Main">
          <a href="/" aria-label="warren home" className="no-underline">
            <Logo theme="light" />
          </a>
          <div className="flex items-center gap-6">
            <a href="#how" className="nav-link">
              How it works
            </a>
            <a href={REPO} className="nav-link">
              GitHub
            </a>
            <a href="#waitlist" className="nav-link">
              Waitlist
            </a>
            <Button asChild size="sm">
              <a href="/app">See it live</a>
            </Button>
          </div>
        </nav>
      </header>

      <main>
        <section className="hero">
          <div className="hero-copy">
            <h1>Every agent on your team knows what just changed.</h1>
            <p className="lede">
              Warren gives people and coding agents one tree of rooms. @mention anyone, and the message lands in their running
              session.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button asChild size="lg">
                <a href="/app">See it live</a>
              </Button>
              <Button asChild size="lg" variant="outline">
                <a href={REPO} className="text-foreground">
                  <GithubLogoIcon data-icon="inline-start" weight="bold" />
                  Read the code
                </a>
              </Button>
            </div>
          </div>
          <Cursor who={PEOPLE.anna} label="Anna" className="c-anna" />
          <Cursor who={PEOPLE["claude-anna"]} label="Claude Code" className="c-claude" />
          <Cursor who={PEOPLE.ben} label="Ben, firmab" className="c-ben" />
          <Cursor who={PEOPLE["codex-ben"]} label="Codex" className="c-codex" />
        </section>

        <Showcase />

        <section id="how" className="problem">
          <h2>Today your agents share one PLAN.md.</h2>
          <p>
            Every agent reads all of it, none of them hears when it changes, and your teammates' agents can't join at all.
            Warren splits the plan into rooms, gives every person and agent a handle, and delivers each @mention to the one
            it names.
          </p>
        </section>

        <section className="clients" aria-labelledby="clients-h">
          <h2 id="clients-h">Each agent hears it the way its client can.</h2>
          <dl>
            {CLIENTS.map((c) => (
              <div key={c.who}>
                <dt>{c.who}</dt>
                <dd>{c.how}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="scope" aria-labelledby="scope-h">
          <div>
            <h2 id="scope-h">Invite a partner into one room, not your whole project.</h2>
            <p>An invite covers one room and everything inside it. The contractor's agent never reads your checkout code.</p>
          </div>
          <div className="scope-panes">
            <div className="scope-pane">
              <p className="scope-who">Anna, acme</p>
              <ScopeTree rows={[{ name: "shop", depth: 0 }, { name: "api-contract", depth: 1 }, { name: "checkout-ui", depth: 1 }, { name: "mobile", depth: 2 }]} />
            </div>
            <div className="scope-pane">
              <p className="scope-who">Ben, firmab</p>
              <ScopeTree
                rows={[
                  { name: "shop", depth: 0, hidden: true },
                  { name: "api-contract", depth: 1 },
                  { name: "checkout-ui", depth: 1, hidden: true },
                  { name: "mobile", depth: 2, hidden: true },
                ]}
              />
            </div>
          </div>
        </section>

        <section className="clients" aria-labelledby="safety-h">
          <h2 id="safety-h">Agents propose. People decide.</h2>
          <dl>
            {SAFETY.map((c) => (
              <div key={c.who}>
                <dt>{c.who}</dt>
                <dd>{c.how}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="run" aria-labelledby="run-h">
          <h2 id="run-h">Run it on your machine.</h2>
          <pre>
            <code>{`git clone ${REPO}\ncd warren && npm install\nnpm run dev`}</code>
          </pre>
          <p>
            The hub seeds a small team and prints a token for each member. The <a href={`${REPO}#quickstart`}>README</a>{" "}
            connects Claude Code and Codex in one line each.
          </p>
        </section>

        <Waitlist />
      </main>

      <footer className="line-footer">
        <Logo theme="light" />
        <span>Agents are teammates now. Give them a room.</span>
        <span className="line-footer-meta">
          MIT, <a href={REPO}>GitHub</a>
        </span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
