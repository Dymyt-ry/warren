// Live, read-only view of the room tree, on the brand tokens. Composer,
// @mentions and the full design pass are next.
import { StrictMode, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { Logo } from "./Logo";

interface Message { id: string; roomId: string; from: string; kind: string; text: string; at: string }
interface Room { id: string; parentId: string | null; name: string; context: string; messages: Message[] }

function Dashboard() {
  const [rooms, setRooms] = useState<Record<string, Room>>({});
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/rooms")
      .then((r) => r.json())
      .then((list: Room[]) => setRooms(Object.fromEntries(list.map((r) => [r.id, r]))));

    const es = new EventSource("/api/events");
    es.addEventListener("room", (e) => {
      const room: Room = JSON.parse((e as MessageEvent).data);
      setRooms((prev) => ({ ...prev, [room.id]: room }));
    });
    es.addEventListener("message", (e) => {
      const m: Message = JSON.parse((e as MessageEvent).data);
      setRooms((prev) => {
        const room = prev[m.roomId];
        if (!room || room.messages.some((x) => x.id === m.id)) return prev;
        return { ...prev, [m.roomId]: { ...room, messages: [...room.messages, m] } };
      });
    });
    return () => es.close();
  }, []);

  const children = useMemo(() => {
    const map: Record<string, Room[]> = {};
    for (const r of Object.values(rooms)) (map[r.parentId ?? "root"] ??= []).push(r);
    return map;
  }, [rooms]);

  const renderTree = (parent: string, depth: number) =>
    (children[parent] ?? []).map((r) => {
      const last = r.messages.at(-1);
      return (
        <div key={r.id}>
          <button
            className={`room ${selected === r.id ? "active" : ""} ${last?.kind === "done" ? "done" : ""}`}
            style={{ paddingLeft: 12 + depth * 18 }}
            onClick={() => setSelected(r.id)}
          >
            {depth ? "└ " : ""}
            {r.name}
            {r.messages.length > 0 && <span className="count">{r.messages.length}</span>}
          </button>
          {renderTree(r.id, depth + 1)}
        </div>
      );
    });

  const room = selected ? rooms[selected] : undefined;

  return (
    <div className="dash">
      <aside>
        <h1>
          <Logo />
        </h1>
        {renderTree("root", 0)}
      </aside>
      <main>
        {room ? (
          <>
            <h2>{room.name}</h2>
            <pre className="context">{room.context}</pre>
            <ol className="thread">
              {room.messages.map((m) => (
                <li key={m.id} className={`msg ${m.kind}`}>
                  <header>
                    <b>{m.from}</b> <span className="kind">{m.kind}</span>{" "}
                    <time>{new Date(m.at).toLocaleTimeString()}</time>
                  </header>
                  <p>{m.text}</p>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="empty">Pick a room.</p>
        )}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Dashboard />
  </StrictMode>,
);
