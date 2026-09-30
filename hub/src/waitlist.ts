// Waitlist for the hosted version. The one thing on the hub that must survive
// a redeploy, so it is appended to a JSONL file under WARREN_DATA_DIR (a
// persistent volume in production). Stores only what people typed in: no IP,
// no user agent. Rate limits per IP live in memory only.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WaitlistEntry {
  email: string;
  name: string;
  company: string;
  useCase: string;
  at: string;
}

const DIR = process.env.WARREN_DATA_DIR ?? "data";
const FILE = join(DIR, "waitlist.jsonl");
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,63}$/;
const PER_IP_PER_HOUR = 5;

const entries: WaitlistEntry[] = existsSync(FILE)
  ? readFileSync(FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as WaitlistEntry)
  : [];
const recent = new Map<string, number[]>(); // ip -> timestamps of sign-ups in the last hour

const field = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Adds a sign-up. Returns the stored entry so the caller can send a confirmation. */
export function joinWaitlist(input: Record<string, unknown>, ip: string): { position: number; already: boolean; entry: WaitlistEntry } {
  const email = field(input.email, 254).toLowerCase();
  if (!EMAIL.test(email)) throw new Error("a valid email is required");

  const existing = entries.findIndex((e) => e.email === email);
  if (existing !== -1) return { position: existing + 1, already: true, entry: entries[existing] };

  const now = Date.now();
  const hits = (recent.get(ip) ?? []).filter((t) => now - t < 3_600_000);
  if (hits.length >= PER_IP_PER_HOUR) throw new RateLimited();
  recent.set(ip, [...hits, now]);

  const entry: WaitlistEntry = {
    email,
    name: field(input.name, 120),
    company: field(input.company, 120),
    useCase: field(input.useCase, 1000),
    at: new Date(now).toISOString(),
  };
  mkdirSync(DIR, { recursive: true });
  appendFileSync(FILE, JSON.stringify(entry) + "\n");
  entries.push(entry);
  return { position: entries.length, already: false, entry };
}

export class RateLimited extends Error {
  constructor() {
    super("too many sign-ups from this address, try again later");
  }
}

export const waitlistCount = () => entries.length;
export const waitlistEntries = () => [...entries];
