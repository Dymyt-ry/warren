/**
 * Parse deployment configuration once and fail closed on ambiguous values.
 * Security controls must never silently turn off because an env var contains a typo.
 */

const raw = (name: string) => process.env[name];

function fail(name: string, message: string): never {
  throw new Error(`invalid ${name}: ${message}`);
}

export function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = raw(name);
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) fail(name, `expected an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(name, `expected an integer from ${min} to ${max}`);
  return parsed;
}

export function flagEnv(name: string, fallback = false): boolean {
  const value = raw(name);
  if (value === undefined || value === "") return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  return fail(name, 'expected "1" or "0"');
}

function enumEnv<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const value = raw(name);
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return fail(name, `expected one of: ${allowed.join(", ")}`);
}

export const NODE_ENV = enumEnv("NODE_ENV", "development", ["development", "test", "production"] as const);
export const PRODUCTION = NODE_ENV === "production";
export const PORT = integerEnv("PORT", 8790, 1, 65_535);

function publicUrl(): URL {
  const configured = raw("PUBLIC_URL");
  if (PRODUCTION && !configured) fail("PUBLIC_URL", "is required when NODE_ENV=production");
  const value = configured ?? `http://localhost:${PORT}`;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("PUBLIC_URL", "expected an absolute http:// or https:// URL");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) fail("PUBLIC_URL", "only http:// and https:// are supported");
  const hostnameIsSafe = url.hostname.startsWith("[") ? /^\[[0-9a-f:.]+\]$/i.test(url.hostname) : /^[a-z0-9.-]+$/i.test(url.hostname);
  if (!hostnameIsSafe) fail("PUBLIC_URL", "hostname contains unsupported characters");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    fail("PUBLIC_URL", "must be an origin without credentials, path, query, or fragment");
  if (PRODUCTION && url.protocol !== "https:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
    fail("PUBLIC_URL", "production deployments must use https:// (localhost is allowed for a local proxy)");
  return url;
}

export const PUBLIC_URL_OBJECT = publicUrl();
export const PUBLIC_URL = PUBLIC_URL_OBJECT.origin;
export const DEMO = flagEnv("WARREN_DEMO");
export const SEED_DEMO = flagEnv("WARREN_SEED", true);
export const LANDING = flagEnv("WARREN_LANDING");
export const DASHBOARD_OPEN = enumEnv("WARREN_DASHBOARD", "open", ["open", "closed"] as const) === "open";

// Demo mode contains fixed credentials published in the source tree. Refuse to
// expose it accidentally from a production image; an explicitly public sandbox
// must acknowledge that trade-off, and should live on a disposable instance.
export const ALLOW_PUBLIC_DEMO = flagEnv("WARREN_ALLOW_PUBLIC_DEMO");
if (PRODUCTION && DEMO && !ALLOW_PUBLIC_DEMO)
  fail("WARREN_DEMO", "fixed demo credentials are forbidden in production; use /demo or set WARREN_ALLOW_PUBLIC_DEMO=1 for a disposable public sandbox");

export const DATA_DIR = raw("WARREN_DATA_DIR") || "data";
export const DB_PATH = raw("WARREN_DB") || undefined;
if (PRODUCTION && !DEMO && DB_PATH === ":memory:") fail("WARREN_DB", ":memory: is forbidden for a production hub");

export const LOGIN_LIMIT = integerEnv("WARREN_LOGIN_LIMIT", 30, 1, 10_000);
export const ACCOUNT_LIMIT = integerEnv("WARREN_ACCOUNT_LIMIT", 10, 1, 10_000);
export const LOOP_LIMIT = integerEnv("WARREN_LOOP_LIMIT", 8, 1, 1_000);
export const STREAMS_PER_CALLER = integerEnv("WARREN_STREAMS_PER_CALLER", 12, 1, 1_000);
export const STREAMS_TOTAL = integerEnv("WARREN_STREAMS_TOTAL", 2_000, 1, 100_000);
if (STREAMS_TOTAL < STREAMS_PER_CALLER) fail("WARREN_STREAMS_TOTAL", "must be at least WARREN_STREAMS_PER_CALLER");
export const DELIVERY_LEASE_MS = integerEnv("WARREN_DELIVERY_LEASE_MS", 15 * 60_000, 30_000, 24 * 60 * 60_000);

function trustProxy(): false | number | string {
  const value = raw("WARREN_TRUST_PROXY");
  if (value === undefined || value === "" || value === "0" || value === "false") return false;
  if (value === "true") return fail("WARREN_TRUST_PROXY", 'do not trust every proxy; use a hop count such as "1" or explicit proxy addresses');
  if (/^\d+$/.test(value)) return integerEnv("WARREN_TRUST_PROXY", 0, 1, 32);
  if (/[^a-zA-Z0-9:.,/ _-]/.test(value)) fail("WARREN_TRUST_PROXY", "contains invalid characters");
  return value;
}

export const TRUST_PROXY = trustProxy();
const ipHeader = raw("WARREN_CLIENT_IP_HEADER")?.toLowerCase();
if (ipHeader && !/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(ipHeader)) fail("WARREN_CLIENT_IP_HEADER", "expected one HTTP header name");
if (ipHeader && TRUST_PROXY === false) fail("WARREN_CLIENT_IP_HEADER", "requires WARREN_TRUST_PROXY");
if (ipHeader && !flagEnv("WARREN_TRUSTED_PROXY_HEADERS"))
  fail("WARREN_CLIENT_IP_HEADER", "requires WARREN_TRUSTED_PROXY_HEADERS=1 to acknowledge that direct origin traffic is blocked");
export const CLIENT_IP_HEADER = ipHeader;

export const ADMIN_TOKEN = raw("WARREN_ADMIN_TOKEN") || undefined;
export const SETUP_TOKEN = raw("WARREN_SETUP_TOKEN") || undefined;
if (PRODUCTION && ADMIN_TOKEN && ADMIN_TOKEN.length < 32) fail("WARREN_ADMIN_TOKEN", "production secrets must contain at least 32 characters");

export const SMTP_HOST = raw("SMTP_HOST") || undefined;
export const SMTP_PORT = integerEnv("SMTP_PORT", 587, 1, 65_535);
export const SMTP_USER = raw("SMTP_USER") || undefined;
export const SMTP_PASS = raw("SMTP_PASS") || undefined;
export const SMTP_FROM = raw("SMTP_FROM") || (SMTP_USER ? `Warren <${SMTP_USER}>` : undefined);
if ([SMTP_HOST, SMTP_USER, SMTP_PASS, SMTP_FROM].some(Boolean) && !(SMTP_HOST && SMTP_USER && SMTP_PASS && SMTP_FROM))
  fail("SMTP_*", "SMTP_HOST, SMTP_USER, SMTP_PASS, and SMTP_FROM (or SMTP_USER fallback) must form a complete configuration");
