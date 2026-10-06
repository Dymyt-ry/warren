const fail = (name: string, message: string): never => {
  throw new Error(`invalid ${name}: ${message}`);
};

function enumEnv<T extends string>(name: string, fallback: T, allowed: readonly T[]): T {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  return fail(name, `expected one of: ${allowed.join(", ")}`);
}

function integerEnv(name: string, fallback: number, min: number, max: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) return fail(name, `expected an integer from ${min} to ${max}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fail(name, `expected an integer from ${min} to ${max}`);
  return parsed;
}

function hubUrl(): string {
  const value = process.env.WARREN_HUB ?? "http://localhost:8790";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("WARREN_HUB", "expected an absolute http:// or https:// URL");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol)) return fail("WARREN_HUB", "only http:// and https:// are supported");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    return fail("WARREN_HUB", "must be an origin without credentials, path, query, or fragment");
  return url.origin;
}

export const HUB = hubUrl();
export const TOKEN = process.env.WARREN_TOKEN;
export const APPROVER_KEY = process.env.WARREN_APPROVER_KEY;
export const ADAPTER = enumEnv("WARREN_ADAPTER", "channel", ["channel", "exec"] as const);
export const EXEC_CLIENT = enumEnv("WARREN_EXEC_CLIENT", "codex", ["codex", "cursor"] as const);
export const EXEC_CMD = process.env.WARREN_EXEC_CMD || (EXEC_CLIENT === "cursor" ? "cursor-agent" : "codex");
export const EXEC_SESSION = process.env.WARREN_EXEC_SESSION ?? process.env.WARREN_CODEX_SESSION;
export const EXEC_TIMEOUT_MS = integerEnv("WARREN_EXEC_TIMEOUT_MS", 10 * 60_000, 1_000, 24 * 60 * 60_000);
