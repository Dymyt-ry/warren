// Codex has no push into a live session, so the bridge wakes it instead:
//   codex exec resume <WARREN_CODEX_SESSION> "<message>"
// Codex resumes the same thread with its full context, does the work and
// answers through its own Warren MCP connection. Messages are queued so two
// arrivals never run two turns at once.
import { spawn } from "node:child_process";
import type { HubMessage } from "../sse.js";

// WARREN_EXEC_CMD lets tests swap codex for a stub.
const CMD = process.env.WARREN_EXEC_CMD ?? "codex";
const SESSION = process.env.WARREN_CODEX_SESSION;
let queue = Promise.resolve();

export function deliverViaExec(m: HubMessage) {
  const prompt =
    `[warren] ${m.kind} from @${m.from} in room "${m.roomId}":\n${m.text}\n\n` +
    `Handle it, then answer in room "${m.roomId}" with the warren post tool, mentioning @${m.from} ` +
    `(kind=done when you finished the work).`;
  const args = ["exec", "resume", ...(SESSION ? [SESSION] : ["--last"]), prompt];
  queue = queue.then(
    () =>
      new Promise<void>((resolve) => {
        // stdout of the child must not reach ours: ours is the MCP transport
        const child = spawn(CMD, args, { stdio: ["ignore", "ignore", "inherit"] });
        child.on("exit", () => resolve());
        child.on("error", (e) => {
          console.error(`warren-bridge: ${CMD} failed: ${e.message}`);
          resolve();
        });
      }),
  );
  return queue;
}
