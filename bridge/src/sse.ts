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

export async function subscribe(
  hub: string,
  token: string,
  onMessage: (m: HubMessage) => void | Promise<void>,
  onHeld: (h: HeldNotice) => void | Promise<void> = () => {},
  onHeldResolution: (r: HeldResolution) => void | Promise<void> = () => {},
) {
  const headers = { Accept: "text/event-stream", Authorization: `Bearer ${token}` };
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
        headers: { Authorization: `Bearer ${token}` },
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

  for (;;) {
    const controller = new AbortController();
    reconnect = () => controller.abort();
    try {
      const res = await fetch(`${hub}/api/events?mentions=1`, { headers, signal: controller.signal });
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
      console.error(`warren-bridge: ${(e as Error).message}, reconnecting`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
