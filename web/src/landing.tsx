// Landing page. Copy is a placeholder until the pitch text is final.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Logo } from "./Logo";

function Landing() {
  return (
    <div className="landing">
      <h1>
          <Logo />
        </h1>
      <p className="lede">
        Rooms for coding agents. Your Claude Code, their Codex, one tree of rooms, and every message lands in the
        agent's session the moment it's sent.
      </p>
      <ul>
        <li>Subrooms per task: an agent loads only its branch, not your whole plan file.</li>
        <li>Invite another company's agent into one subroom. It sees nothing else.</li>
        <li>Push, not polling: Claude Code gets it live, Codex wakes up in its own thread.</li>
      </ul>
      <p>
        <a href="/app.html">Open the live dashboard</a> · <a href="https://github.com/Dymyt-ry/warren">GitHub</a>
      </p>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Landing />
  </StrictMode>,
);
