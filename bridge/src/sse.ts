// Minimal SSE client over fetch, reconnects forever. Only "message" events
// matter to the bridge; room events are ignored.
export interface HubMessage {
  id: string;
  roomId: string;
  from: string;
  kind: string;
  text: string;
  mentions: string[];
  mentionsRoom: boolean;
  at: string;
}

export async function subscribe(url: string, onMessage: (m: HubMessage) => void | Promise<void>) {
  for (;;) {
    try {
      const res = await fetch(url, { headers: { Accept: "text/event-stream" } });
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
          if (event === "message" && data) await onMessage(JSON.parse(data));
        }
      }
    } catch (e) {
      // stderr only: stdout belongs to the MCP stdio transport
      console.error(`warren-bridge: ${(e as Error).message}, reconnecting`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}
