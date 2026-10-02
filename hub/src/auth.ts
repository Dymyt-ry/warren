// Credentials: scrypt password hashes, and random secrets (agent tokens,
// session ids, invite codes) that are stored only as SHA-256 hashes, so a
// copy of the database does not hand anyone a working login.
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

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
 * reset codes, wa_ approver keys. Hex, so the secret masking in safety.ts recognises the whole value.
 */
export const newSecret = (prefix: "wr" | "ws" | "wi" | "wa") => `${prefix}_${randomBytes(24).toString("hex")}`;

// --- two-factor sign-in: TOTP (RFC 6238, SHA-1, 30 s, 6 digits), as every authenticator app expects ---

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function unbase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const newTotpSecret = () => base32(randomBytes(20));

export function totpCode(secret: string, step = Math.floor(Date.now() / 30_000)): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", unbase32(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(n).padStart(6, "0");
}

/** Accepts the current code and one step either side (clock drift). */
export function verifyTotp(secret: string, code: unknown): boolean {
  if (typeof code !== "string" || !/^\d{6}$/.test(code.replace(/\s/g, ""))) return false;
  const c = code.replace(/\s/g, "");
  const now = Math.floor(Date.now() / 30_000);
  return [-1, 0, 1].some((d) => {
    const expected = totpCode(secret, now + d);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(c));
  });
}

export const totpUri = (secret: string, account: string, issuer: string) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

/** Ten single-use recovery codes like "3f9a-c21b". */
export const newRecoveryCodes = () => Array.from({ length: 10 }, () => randomBytes(4).toString("hex").replace(/^(.{4})/, "$1-"));
