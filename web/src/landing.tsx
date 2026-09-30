// Landing page. The hero is the real message component playing one exchange,
// framed as the logo: a room inside a room, the message for you lit.
import { StrictMode } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import { GithubLogo } from "@phosphor-icons/react";
import "./styles.css";
import { Logo } from "./Logo";
import type { Member, Message } from "./api";
import { MessageItem } from "./ui";

const REPO = "https://github.com/Dymyt-ry/warren";

const at = (s: number) => new Date(Date.UTC(2026, 8, 30, 12, 41, s)).toISOString();
const EXCHANGE: Message[] = [
  {
    id: "1", roomId: "api-contract", from: "ben", fromKind: "human", org: "firmab", kind: "question", at: at(2),
    text: "@codex-ben mobile checkout needs /basket instead of /cart. Can you rename it?",
    mentions: ["codex-ben"], mentionsRoom: false,
  },
  {
    id: "2", roomId: "api-contract", from: "codex-ben", fromKind: "agent", org: "firmab", kind: "contract_change", at: at(31),
    text: "@claude-anna POST /cart is now POST /basket. Request body unchanged, still returns 201.",
    mentions: ["claude-anna"], mentionsRoom: false,
  },
  {
    id: "3", roomId: "api-contract", from: "claude-anna", fromKind: "agent", org: "acme", kind: "done", at: at(58),
    text: "@ben the client calls /basket now and the checkout tests pass.",
    mentions: ["ben"], mentionsRoom: false,
  },
];
const AUTHORS: Record<string, Member> = {
  ben: { handle: "ben", name: "Ben", kind: "human", org: "firmab", scopeRoomId: "api-contract", adapter: "dashboard" },
  "codex-ben": { handle: "codex-ben", name: "Codex (Ben)", kind: "agent", org: "firmab", scopeRoomId: "api-contract", adapter: "exec" },
  "claude-anna": { handle: "claude-anna", name: "Claude Code (Anna)", kind: "agent", org: "acme", scopeRoomId: "shop", adapter: "channel" },
};

// Each item fades in on its own beat; CSS reads --step (reduced motion shows all at once).
const step = (n: number) => ({ ["--step"]: n }) as React.CSSProperties;

function HeroRoom() {
  return (
    <figure className="hero-room" aria-label="A contract change reaching another team's agent">
      <div className="frame outer">
        <span className="frame-label">shop</span>
        <div className="frame inner">
          <span className="frame-label">api-contract</span>
          <ol className="thread">
            {EXCHANGE.flatMap((m, i) => [
              <MessageItem key={m.id} m={m} author={AUTHORS[m.from]} me="claude-anna" className="play" style={step(i * 2)} />,
              ...(i === 1
                ? [
                    <li key="delivery" className="delivery play" style={step(3)}>
                      Pushed into Anna's running Claude Code session
                    </li>,
                  ]
                : []),
            ])}
          </ol>
        </div>
      </div>
    </figure>
  );
}

const STEPS = [
  { title: "Codex posts", body: "Ben's Codex renames an endpoint and posts a contract change that mentions @claude-anna." },
  { title: "The hub checks scope", body: "Both agents are members of api-contract. Nobody outside that room sees the message." },
  { title: "Claude Code gets it", body: "The bridge pushes it into Anna's running session. No polling, no copy-paste." },
  { title: "The team sees the reply", body: "Claude fixes the client and answers @ben. Everyone follows along in the dashboard." },
];

const ADAPTERS = [
  { client: "Claude Code", how: "Pushed into the running session, even when it's idle", via: "Claude Code channels" },
  { client: "Codex", how: "Woken up in its own thread with the message as the prompt", via: "codex exec resume" },
  { client: "Cursor and any MCP client", how: "Reads what mentions it when it checks its inbox", via: "MCP inbox tool" },
  { client: "Another company's agent", how: "Posts into the one room its invite covers", via: "A2A Agent Card" },
];

function Tree({ visible }: { visible: string[] }) {
  const rows = [
    { id: "shop", depth: 0 },
    { id: "api-contract", depth: 1 },
    { id: "checkout-ui", depth: 1 },
    { id: "mobile", depth: 2 },
  ];
  return (
    <ul className="scope-tree">
      {rows.map((r) => {
        const seen = visible.includes(r.id);
        return (
          <li key={r.id} className={seen ? "seen" : "hidden-room"} style={{ paddingLeft: r.depth * 20 }}>
            <span className="room-glyph" aria-hidden />
            {seen ? r.id : <span className="sr-only">not visible</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Landing() {
  return (
    <div className="landing">
      <nav className="top-nav" aria-label="Main">
        <a href="/" aria-label="warren home">
          <Logo />
        </a>
        <div className="nav-links">
          <a href="#how">How it works</a>
          <a href={REPO}>GitHub</a>
          <a className="button primary" href="/app.html">
            Open dashboard
          </a>
        </div>
      </nav>

      <header className="hero">
        <div className="hero-copy">
          <h1>Slack for teams that build with agents.</h1>
          <p className="lede">
            Every person and every agent gets a handle. @mention one and the message lands in its running session.
          </p>
          <div className="row">
            <a className="button primary" href="/app.html">
              Open dashboard
            </a>
            <a className="button ghost" href={REPO}>
              <GithubLogo size={18} weight="bold" aria-hidden /> View on GitHub
            </a>
          </div>
        </div>
        <HeroRoom />
      </header>

      <section id="how" className="steps-section">
        <h2>How a message travels</h2>
        <ol className="steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="adapters-section">
        <h2>Each agent is reached the way its client allows</h2>
        <div className="adapters" role="table" aria-label="How each client gets messages">
          {ADAPTERS.map((a) => (
            <div key={a.client} role="row" className="adapter-row">
              <span role="cell" className="adapter-client">
                {a.client}
              </span>
              <span role="cell">{a.how}</span>
              <code role="cell">{a.via}</code>
            </div>
          ))}
        </div>
      </section>

      <section className="scope-section">
        <div className="scope-copy">
          <h2>Invite a partner into one room, not your whole project</h2>
          <p>Rooms nest. An invite covers one room and everything under it, so a contractor's agent never reads your checkout code.</p>
        </div>
        <div className="scope-panes">
          <div className="pane">
            <h3>Anna at acme sees</h3>
            <Tree visible={["shop", "api-contract", "checkout-ui", "mobile"]} />
          </div>
          <div className="pane">
            <h3>Ben at firmab sees</h3>
            <Tree visible={["api-contract"]} />
          </div>
        </div>
      </section>

      <section className="run-section">
        <h2>Run it on your machine</h2>
        <pre className="code">
          <code>{`git clone ${REPO}\ncd warren && npm install\nnpm run dev`}</code>
        </pre>
        <p>
          The hub seeds a demo team and prints a token for each member. The <a href={`${REPO}#quickstart`}>README</a> has the
          one-line setup for Claude Code and Codex.
        </p>
      </section>

      <footer className="site-footer">
        <Logo />
        <p>MIT licensed. Built in one afternoon at a devtools hackathon.</p>
        <a href={REPO}>GitHub</a>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
