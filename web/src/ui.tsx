// Pieces shared by the landing map and the dashboard, so the landing shows the real UI.
// Shapes follow the mark: people are circles, agents are rooms (a rounded square with a room inside).
import type React from "react";
import type { Member, Message, MessageKind } from "./api";

export function Avatar({
  kind,
  name,
  size = 32,
  lit = false,
}: {
  kind: Member["kind"];
  name: string;
  size?: number;
  lit?: boolean;
}) {
  return kind === "agent" ? (
    <span className={`avatar agent${lit ? " lit" : ""}`} style={{ width: size, height: size }} aria-hidden>
      <span className="avatar-room" />
    </span>
  ) : (
    <span className={`avatar human${lit ? " lit" : ""}`} style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const KIND_LABEL: Record<MessageKind, string | null> = {
  note: null,
  question: "Question",
  contract_change: "Contract change",
  done: "Done",
};

/** A message's kind as a small room glyph plus a word; colour only where the kind has a colour role. */
export function KindTag({ kind }: { kind: MessageKind }) {
  const label = KIND_LABEL[kind];
  if (!label) return null;
  return (
    <span className={`kind kind-${kind}`}>
      <span className="kind-glyph" aria-hidden />
      {label}
    </span>
  );
}

const MENTION = /(@[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)?)/gi;

/** Message text with @mentions set apart; mentions of `me` (or @room) are lit. */
export function MentionText({ text, me }: { text: string; me?: string | null }) {
  return (
    <>
      {text.split(MENTION).map((part, i) => {
        if (i % 2 === 0) return part;
        const handle = part.slice(1).toLowerCase().split("/")[0];
        const lit = !!me && (handle === me || handle === "room" || handle === "here" || handle === "all");
        return (
          <span key={i} className={lit ? "mention lit" : "mention"}>
            {part}
          </span>
        );
      })}
    </>
  );
}

export function MessageItem({
  m,
  author,
  me,
  external,
  className = "",
  style,
}: {
  m: Message;
  author?: Member;
  me?: string | null;
  external?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const forMe = !!me && m.from !== me && (m.forYou || m.mentions.includes(me) || m.mentionsRoom);
  const time = new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const sessionName = m.metadata?.from.sessionNameSnapshot ?? m.metadata?.from.sessionName;
  return (
    <li className={`msg${forMe ? " for-me" : ""} ${className}`} style={style}>
      <Avatar kind={m.fromKind} name={author?.name ?? m.from} />
      <div className="msg-body">
        <header>
          <span className="msg-name">{author?.name ?? m.from}{sessionName ? ` · ${sessionName}` : ""}</span>
          {external && <span className="org">{m.org}</span>}
          <KindTag kind={m.kind} />
          <time dateTime={m.at}>{time}</time>
        </header>
        <p>
          <MentionText text={m.text} me={me} />
        </p>
      </div>
    </li>
  );
}
