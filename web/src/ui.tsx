// Pieces shared by the landing hero and the dashboard, so the landing shows the real UI.
import { CheckCircle, Robot, Swap, Question } from "@phosphor-icons/react";
import type React from "react";
import type { Member, Message, MessageKind } from "./api";

export function Avatar({ kind, name, size = 32 }: { kind: Member["kind"]; name: string; size?: number }) {
  return kind === "agent" ? (
    <span className="avatar agent" style={{ width: size, height: size }} aria-hidden>
      <Robot size={size * 0.55} weight="bold" />
    </span>
  ) : (
    <span className="avatar human" style={{ width: size, height: size, fontSize: size * 0.42 }} aria-hidden>
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

const KIND_LABEL: Record<MessageKind, { label: string; Icon?: typeof Swap } | null> = {
  note: null,
  question: { label: "Question", Icon: Question },
  contract_change: { label: "Contract change", Icon: Swap },
  done: { label: "Done", Icon: CheckCircle },
};

export function KindTag({ kind }: { kind: MessageKind }) {
  const k = KIND_LABEL[kind];
  if (!k) return null;
  const Icon = k.Icon!;
  return (
    <span className={`kind kind-${kind}`}>
      <Icon size={13} weight="bold" aria-hidden />
      {k.label}
    </span>
  );
}

const MENTION = /(@[a-z0-9][a-z0-9_-]*)/gi;

/** Message text with @mentions set apart; mentions of `me` (or @room) are lit. */
export function MentionText({ text, me }: { text: string; me?: string | null }) {
  return (
    <>
      {text.split(MENTION).map((part, i) => {
        if (i % 2 === 0) return part;
        const handle = part.slice(1).toLowerCase();
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
  return (
    <li className={`msg${forMe ? " for-me" : ""} ${className}`} style={style}>
      <Avatar kind={m.fromKind} name={author?.name ?? m.from} />
      <div className="msg-body">
        <header>
          <span className="msg-name">{author?.name ?? m.from}</span>
          <span className="msg-handle">@{m.from}</span>
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
