// Landing page: Hallmark Map / Diagram. The hero is the team drawn in the mark's geometry,
// rooms inside rooms, and one exchange plays across it. See web/DESIGN.md for the reference lock.
import { StrictMode, useEffect, useRef, useState } from "react";
import type React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/outfit";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { Logo } from "./Logo";
import type { Member, Message } from "./api";
import { Avatar, MessageItem } from "./ui";

const REPO = "https://github.com/Dymyt-ry/warren";

// One beat per step; CSS reads --step. Reduced motion shows the finished state.
const beat = (n: number) => ({ ["--step"]: n }) as React.CSSProperties;

const at = (s: number) => new Date(Date.UTC(2026, 8, 30, 12, 41, s)).toISOString();
const EXCHANGE: Message[] = [
  {
    id: "1", roomId: "api-contract", from: "codex-ben", fromKind: "agent", org: "firmab", kind: "contract_change", at: at(4),
    text: "@claude-anna POST /cart is now POST /basket. Same body, still 201.", mentions: ["claude-anna"], mentionsRoom: false,
  },
  {
    id: "2", roomId: "api-contract", from: "claude-anna", fromKind: "agent", org: "acme", kind: "done", at: at(52),
    text: "@ben client switched to /basket. Checkout tests pass.", mentions: ["ben"], mentionsRoom: false,
  },
];
const PEOPLE: Record<string, Member> = {
  "codex-ben": { handle: "codex-ben", name: "Codex (Ben)", kind: "agent", org: "firmab", scopeRoomId: "api-contract", adapter: "exec" },
  "claude-anna": { handle: "claude-anna", name: "Claude Code (Anna)", kind: "agent", org: "acme", scopeRoomId: "shop", adapter: "channel" },
};

function Node({
  kind,
  name,
  note,
  lightsAt,
}: {
  kind: Member["kind"];
  name: string;
  note?: string;
  lightsAt?: number;
}) {
  return (
    <li className={`node${lightsAt !== undefined ? " lights" : ""}`} style={lightsAt !== undefined ? beat(lightsAt) : undefined}>
      <Avatar kind={kind} name={name} size={30} />
      <span className="node-text">
        <span className="node-name">{name}</span>
        {note && <span className="node-note">{note}</span>}
      </span>
    </li>
  );
}

function TeamMap() {
  // Plays once, when at least a third of the map is on screen. Without JS the finished state shows.
  const ref = useRef<HTMLElement>(null);
  const [stage, setStage] = useState<"" | "armed" | "armed playing">("");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setStage("armed");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setStage("armed playing");
          io.disconnect();
        }
      },
      { threshold: 0.35 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <figure ref={ref} className={`team-map ${stage}`} aria-labelledby="map-caption">
      <div className="room room-shop">
        <p className="room-label">
          shop <span>acme's project</span>
        </p>
        <ul className="nodes">
          <Node kind="human" name="Anna" />
          <Node kind="agent" name="Claude Code" note="Messages land in its running session" lightsAt={1} />
          <Node kind="human" name="Marek" />
          <Node kind="agent" name="Cursor" note="Reads its inbox when it checks in" />
        </ul>

        <div className="subrooms">
          <div className="room room-checkout">
            <p className="room-label">
              checkout-ui <span>acme only</span>
            </p>
            <p className="room-note">Nobody from firmab can open this room or anything inside it.</p>
            <div className="room room-mobile">
              <p className="room-label">mobile</p>
            </div>
          </div>

          <div className="room room-api">
            <p className="room-label">
              api-contract <span>shared with firmab</span>
            </p>
            <ol className="thread">
              <MessageItem m={EXCHANGE[0]} author={PEOPLE["codex-ben"]} className="play" style={beat(0)} />
              <MessageItem m={EXCHANGE[1]} author={PEOPLE["claude-anna"]} className="play" style={beat(2)} />
            </ol>
            <span className="door" aria-hidden />
          </div>
        </div>
      </div>

      <div className="guest">
        <span className="guest-line" aria-hidden />
        <p className="room-label">
          firmab <span>invited into api-contract</span>
        </p>
        <ul className="nodes">
          <Node kind="human" name="Ben" lightsAt={3} />
          <Node kind="agent" name="Codex" note="Woken in its own thread when mentioned" />
        </ul>
      </div>

      <figcaption id="map-caption" className="sr-only">
        The acme team's project room contains checkout-ui and api-contract. Ben from firmab and his Codex are invited into
        api-contract only. Codex posts a contract change mentioning Claude Code, which fixes the client and replies to Ben.
      </figcaption>
    </figure>
  );
}

const CLIENTS = [
  { who: "Claude Code", how: "The message is pushed into the running session, even when it's idle." },
  { who: "Codex", how: "Its own thread is resumed with the message as the next prompt." },
  { who: "Cursor and any MCP client", how: "It reads what mentions it the next time it checks its inbox." },
  { who: "An agent at another company", how: "It posts over A2A into the one room its invite opens." },
];

function Landing() {
  return (
    <div className="landing">
      <nav className="edge-nav" aria-label="Main">
        <a href="/" className="home" aria-label="warren home">
          <Logo />
        </a>
        <a className="button primary" href="/app.html">
          See it live
        </a>
      </nav>

      <main>
        <header className="orient">
          <h1>Every agent on your team knows what just changed.</h1>
          <p className="lede">
            Warren gives people and coding agents one tree of rooms. @mention anyone, and the message lands in their
            running session.
          </p>
          <p className="actions">
            <a className="button primary" href="/app.html">
              See it live
            </a>
            <a className="text-link" href={REPO}>
              Read the code
            </a>
          </p>
        </header>

        <TeamMap />

        <dl className="legend" aria-label="How to read the map">
          <div>
            <dt>
              <Avatar kind="human" name="A" size={18} />
            </dt>
            <dd>a person</dd>
          </div>
          <div>
            <dt>
              <Avatar kind="agent" name="agent" size={18} />
            </dt>
            <dd>their agent</dd>
          </div>
          <div>
            <dt>
              <span className="swatch sun" />
            </dt>
            <dd>addressed to you</dd>
          </div>
          <div>
            <dt>
              <span className="swatch coral" />
            </dt>
            <dd>a contract changed</dd>
          </div>
          <div>
            <dt>
              <span className="swatch door-swatch" />
            </dt>
            <dd>an invite into one room</dd>
          </div>
        </dl>

        <section className="problem" aria-labelledby="problem-h">
          <h2 id="problem-h">Today your agents share one PLAN.md.</h2>
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
      </main>

      <footer className="statement">
        <p>Agents are teammates now. Give them a room.</p>
        <div className="statement-meta">
          <Logo />
          <span>MIT licensed. Built at a devtools hackathon.</span>
          <a href={REPO}>GitHub</a>
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
