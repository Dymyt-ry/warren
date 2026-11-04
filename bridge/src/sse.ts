// Minimal SSE client over fetch, reconnects forever. Two events matter to the
// bridge: "message" (deliver it) and "held" (a message for this agent waits
// for its person). On connect the hub replays what the agent missed while it
// was offline; after a reconnect the inbox is read too, so a mention is never lost.
export interface HubMessage {
  id: string;
  roomId: string;
  from: string;
  kind: string;
  text: string;
  mentions: string[];
  mentionsRoom: boolean;
  at: string;
  late?: boolean; // sent while the agent was offline
  metadata?: { from?: { agent?: string; sessionName?: string } };
}

/** The exact address to reply to: `claude-ana/api` for a named agent session, else the handle. */
export function senderAddress(m: Pick<HubMessage, "from" | "metadata">): string {
  const session = m.metadata?.from?.sessionName;
  return session ? `${m.from}/${session}` : m.from;
}

/** A message to this agent that the hub holds until its person decides. No text: the agent must not read it. */
export interface HeldNotice {
  id: string;
  roomId: string;
  from: string;
  org: string;
  kind: string;
  flags: string[];
  waitsFor: string; // the person who decides (or "org:<company>")
  reviewable: boolean; // this bridge's approver key can decide it
  reviewUrl: string;
}

/** A held message was rejected. Deliberately contains no message text. */
export interface HeldResolution {
  id: string;
  roomId: string;
  resolution: "rejected";
  waitsFor: string;
}

export interface WarrenSession {
  id: string;
  handle: string;
  name: string;
  expiresAt: string;
}

export async function registerSession(hub: string, token: string, name: string, resumeId?: string): Promise<WarrenSession> {
  const res = await fetch(`${hub}/api/agent-sessions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, ...(resumeId ? { resumeId } : {}) }),
  });
  const body = (await res.json().catch(() => ({}))) as WarrenSession & { error?: string };
  if (!res.ok) throw new Error(`cannot open Warren session ${name}: ${body.error ?? `hub answered ${res.status}`}`);
  return body;
}

export async function subscribe(
  hub: string,
  token: string,
  session: WarrenSession,
  connectionHeaders: Record<string, string>,
  onMessage: (m: HubMessage) => void | Promise<void>,
  onHeld: (h: HeldNotice) => void | Promise<void> = () => {},
  onHeldResolution: (r: HeldResolution) => void | Promise<void> = () => {},
  stop?: AbortSignal,
) {
  const headers: Record<string, string> = { ...connectionHeaders, Accept: "text/event-stream" };
  const seen = new Set<string>(); // replay and live stream can overlap
  let reconnect = () => {};
  // Delivery runs outside the read loop: an agent turn can take minutes and
  // must not stall the stream. The exec adapter keeps its own queue for order.
  const handle = async (m: HubMessage) => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    try {
      await onMessage(m);
      const ack = await fetch(`${hub}/api/deliveries/${encodeURIComponent(m.id)}/ack`, {
        method: "POST",
        headers: connectionHeaders,
      });
      if (!ack.ok) throw new Error(`delivery ack answered ${ack.status}`);
      // The hub's durable delivery row is now the source of truth. Keeping
      // every id forever would leak memory in a long-running bridge.
      seen.delete(m.id);
    } catch (e) {
      seen.delete(m.id);
      console.error(`warren-bridge: delivery failed: ${(e as Error).message}`);
      reconnect();
    }
  };

  while (!stop?.aborted) {
    const controller = new AbortController();
    reconnect = () => controller.abort();
    const onStop = () => controller.abort();
    stop?.addEventListener("abort", onStop, { once: true });
    try {
      const res = await fetch(`${hub}/api/events?mentions=1`, { headers, signal: controller.signal });
      if (res.status === 409) {
        let rebound: WarrenSession;
        try {
          rebound = await registerSession(hub, token, session.name, session.id);
        } catch (error) {
          // Someone started this slot again elsewhere: that process owns it now.
          if (/rebound to a newer/.test((error as Error).message)) {
            console.error(`warren-bridge: @${session.handle}/${session.name} was started again elsewhere; this one stops receiving`);
            return "evicted" as const;
          }
          throw error;
        }
        Object.assign(session, rebound);
        connectionHeaders["Warren-Session-Id"] = rebound.id;
        headers["Warren-Session-Id"] = rebound.id;
        console.error(`warren-bridge: rebound @${rebound.handle}/${rebound.name} to a new Warren session`);
        continue;
      }
      if (!res.ok || !res.body) throw new Error(`hub answered ${res.status}`);
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk as Uint8Array, { stream: true });
        let end;
        while ((end = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = frame.match(/^event: (.*)$/m)?.[1];
          const data = frame.match(/^data: (.*)$/m)?.[1];
          if (!data) continue;
          if (event === "message") void handle(JSON.parse(data));
          else if (event === "held") void Promise.resolve(onHeld(JSON.parse(data))).catch((e) => console.error(`warren-bridge: ${(e as Error).message}`));
          else if (event === "held_resolution")
            void Promise.resolve(onHeldResolution(JSON.parse(data))).catch((e) => console.error(`warren-bridge: ${(e as Error).message}`));
        }
      }
    } catch (e) {
      // stderr only: stdout belongs to the MCP stdio transport
      if (!stop?.aborted) console.error(`warren-bridge: ${(e as Error).message}, reconnecting`);
    } finally {
      stop?.removeEventListener("abort", onStop);
    }
    if (stop?.aborted) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return "stopped" as const;
}
