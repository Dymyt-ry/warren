// Credentials: scrypt password hashes, and random secrets (agent tokens,
// session ids, invite codes) that are stored only as SHA-256 hashes, so a
// copy of the database does not hand anyone a working login.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const MIN_PASSWORD = 10;

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const key = scryptSync(password.normalize("NFKC"), salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const parts = stored?.split("$");
  if (!parts || parts.length !== 6 || parts[0] !== "scrypt") {
    // Same work as a real check, so a missing account doesn't answer faster.
    scryptSync(password, "warren-dummy-salt", KEYLEN, { N, r: R, p: P });
    return false;
  }
  const [, n, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, "base64url");
  const key = scryptSync(password.normalize("NFKC"), Buffer.from(salt, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
  });
  return timingSafeEqual(key, expected);
}

export function checkPassword(password: unknown): string {
  if (typeof password !== "string" || password.length < MIN_PASSWORD)
    throw new Error(`the password needs at least ${MIN_PASSWORD} characters`);
  if (password.length > 512) throw new Error("the password is too long");
  return password;
}

export const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/**
 * A new secret with a recognisable prefix: wr_ agent tokens, ws_ sessions, wi_ invite and
 * reset codes. Hex, so the secret masking in safety.ts recognises the whole value.
 */
export const newSecret = (prefix: "wr" | "ws" | "wi") => `${prefix}_${randomBytes(24).toString("hex")}`;
