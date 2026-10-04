// Guards the hub applies to every message before it is stored or pushed.
//
//   1. Secrets are masked: an agent that pastes a key into a room does not
//      hand it to another company.
//   2. Prompt-injection heuristics: a flagged message in a room shared with
//      another org is held; no agent gets it until a person releases it.
//   3. Loop guard: agents talking to agents without a person in between are
//      paused after WARREN_LOOP_LIMIT messages, and a person decides.
//
// Heuristics, not a classifier: they catch the obvious attacks cheaply and
// put a human in the loop; they do not make untrusted text safe.

export type SafetyStatus = "delivered" | "held" | "released" | "rejected";

export interface Safety {
  status: SafetyStatus; // overall: held while any decision is pending
  flags: string[]; // e.g. "override-instructions", "shell-payload", "agent-loop"
  redactions: string[]; // kinds of secrets that were masked, e.g. "github-token"
  reviewedBy?: string; // legacy/summary: handle of the person who made the last decision
  // A room-wide decision (agent loop, contract change under the approval policy):
  // nobody's agent gets the message until it's released.
  gate?: GateDecision;
  // Per-recipient decisions for a message from another company: each person
  // decides for their own agents ("org:<org>" for agents nobody owns).
  approvals?: Record<string, Approval>;
}

export type Decision = "pending" | "released" | "rejected";

export interface GateDecision {
  decision: Decision;
  by?: string;
  at?: string;
}

export interface Approval {
  decision: Decision;
  agents: string[]; // the owner's agents in the room when it was posted
  by?: string;
  at?: string;
}

export const gateDecision = (s: Safety): Decision | undefined => s.gate?.decision;

/** Flags that mean "this text may be an attack", as opposed to process holds. */
export const isAttackFlag = (f: string) => f !== "agent-loop" && f !== "needs-approval" && f !== "strict";

/** Overall status from the gate and the per-owner decisions. */
export function settle(s: Safety): SafetyStatus {
  const gate = gateDecision(s);
  const decisions = [...(gate ? [gate] : []), ...Object.values(s.approvals ?? {}).map((a) => a.decision)];
  if (decisions.length === 0) return "delivered";
  if (gate === "rejected") return "rejected";
  if (decisions.includes("pending")) return "held";
  return decisions.includes("released") ? "released" : "rejected";
}

const SECRETS: [string, RegExp][] = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["warren-token", /\bw[rsia]_[a-z0-9_]{8,}\b/gi],
  ["anthropic-key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai-key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["stripe-key", /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}/g],
  ["google-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ["password", /\b(password|passwd|secret|api[_-]?key|access[_-]?token)(\s*[:=]\s*)["']?[^\s"',;]{8,}/gi],
];

/** Masks secrets in `text`. Returns the masked text and the kinds found. */
export function redactSecrets(text: string): { text: string; redactions: string[] } {
  const redactions: string[] = [];
  for (const [kind, re] of SECRETS) {
    text = text.replace(re, (...m: string[]) => {
      redactions.push(kind);
      // keep the "password=" part so the sentence still reads
      return kind === "password" ? `${m[1]}${m[2]}[redacted:${kind}]` : `[redacted:${kind}]`;
    });
  }
  return { text, redactions: [...new Set(redactions)] };
}

const INJECTION: [string, RegExp][] = [
  ["override-instructions", /\b(ignore|disregard|forget|override)\b[^.\n]{0,30}\b(previous|prior|above|earlier|all|your|system)\b[^.\n]{0,20}\b(instructions?|prompts?|rules|guidelines)\b/i],
  ["role-hijack", /\b(you are now|from now on you are|new system prompt|system prompt\s*:|act as (an? )?(admin|root|system))/i],
  ["shell-payload", /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z)?sh\b|\brm\s+-rf\s+[~/]|base64\s+(-d|--decode)[^\n]*\|\s*(ba|z)?sh|\bchmod\s+777\b/i],
  ["exfiltration", /\b(send|post|upload|paste|share|print|reveal|leak|email)\b[^\n]{0,40}?(\.env\b|\b(tokens?|api[ _-]?keys?|secrets?|passwords?|credentials|ssh[ _-]?keys?|private[ _-]?keys?)\b)/i],
  ["destructive", /\bgit\s+push\s+(-f|--force)\b|\bdrop\s+(table|database)\b|\bgit\s+reset\s+--hard\b/i],
  ["hidden-text", /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/],
];

/** Names of the prompt-injection heuristics `text` trips. */
export function injectionFlags(text: string): string[] {
  return INJECTION.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export const LOOP_LIMIT = Number(process.env.WARREN_LOOP_LIMIT ?? 8);
