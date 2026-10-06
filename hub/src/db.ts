// SQLite storage for the hub (node:sqlite, no native dependency). One file
// under WARREN_DATA_DIR, or WARREN_DB to point elsewhere (":memory:" for a
// throwaway hub). Migrations run in order on start; user_version records how
// far this database has got.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DATA_DIR, DB_PATH, DEMO } from "./config.js";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    parent_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT '',
    approve_contract_changes INTEGER NOT NULL DEFAULT 0,
    created_by TEXT,
    created_at TEXT NOT NULL
  );

  -- People and agents. People sign in with email + password and have a role;
  -- agents (and demo people) authenticate with a bearer token, stored hashed.
  -- scope_room_id NULL = the whole instance (owners and admins).
  CREATE TABLE members (
    handle TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('human', 'agent')),
    org TEXT NOT NULL,
    scope_room_id TEXT REFERENCES rooms(id),
    adapter TEXT NOT NULL,
    role TEXT CHECK (role IN ('owner', 'admin', 'member')),
    email TEXT UNIQUE COLLATE NOCASE,
    password_hash TEXT,
    token_hash TEXT UNIQUE,
    owner_handle TEXT,
    paused INTEGER NOT NULL DEFAULT 0,
    disabled INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id_hash TEXT PRIMARY KEY,
    handle TEXT NOT NULL REFERENCES members(handle) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  -- One-time links: invites for new people, password resets for existing ones.
  CREATE TABLE links (
    id TEXT PRIMARY KEY,
    code_hash TEXT UNIQUE NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset')),
    email TEXT,
    org TEXT,
    scope_room_id TEXT REFERENCES rooms(id) ON DELETE CASCADE,
    role TEXT,
    handle TEXT,
    created_by TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    used_by TEXT
  );

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    from_handle TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    org TEXT NOT NULL,
    kind TEXT NOT NULL,
    text TEXT NOT NULL,
    mentions TEXT NOT NULL,
    mentions_room INTEGER NOT NULL,
    safety TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX messages_room ON messages(room_id, seq);

  CREATE TABLE claims (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
    by_handle TEXT NOT NULL,
    task TEXT NOT NULL,
    files TEXT NOT NULL,
    at TEXT NOT NULL
  );

  -- No foreign key: the trail outlives deleted rooms.
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    room_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    target TEXT,
    detail TEXT NOT NULL
  );
  CREATE INDEX audit_room ON audit(room_id, seq);
  `,
  `
  -- Per-person settings (language, theme, safety), two-factor sign-in.
  ALTER TABLE members ADD COLUMN prefs TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE members ADD COLUMN totp_secret TEXT;
  ALTER TABLE members ADD COLUMN totp_pending TEXT;
  ALTER TABLE members ADD COLUMN recovery_codes TEXT;

  -- Which agent got which message pushed (or read it from its inbox):
  -- an agent that was offline gets the rest when it reconnects.
  CREATE TABLE deliveries (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    handle TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (message_id, handle)
  );

  -- Keys a person puts next to their agents so they can approve held messages
  -- from inside the agent's session (Claude Code dialog, bridge terminal).
  CREATE TABLE approver_keys (
    id TEXT PRIMARY KEY,
    handle TEXT NOT NULL REFERENCES members(handle) ON DELETE CASCADE,
    key_hash TEXT UNIQUE NOT NULL,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT
  );
  `,
  `
  -- Security state added after the first 2FA/delivery release.
  ALTER TABLE members ADD COLUMN totp_pending_session_hash TEXT;
  ALTER TABLE members ADD COLUMN totp_pending_expires_at TEXT;
  ALTER TABLE members ADD COLUMN totp_last_step INTEGER;
  ALTER TABLE sessions ADD COLUMN authenticated_at TEXT;

  -- Erased handles remain unavailable without retaining the handle itself.
  CREATE TABLE reserved_handles (
    handle_hash TEXT PRIMARY KEY,
    erased_at TEXT NOT NULL
  );

  -- Old enrollment secrets were not session-bound, and old recovery codes
  -- had only 32 bits and a fast hash. They cannot be upgraded without the
  -- plaintext, so invalidate them fail-closed.
  UPDATE members
     SET totp_pending = NULL,
         recovery_codes = CASE WHEN totp_secret IS NULL THEN NULL ELSE '[]' END;

  CREATE INDEX deliveries_handle ON deliveries(handle, message_id);
  CREATE INDEX links_expiry ON links(expires_at, used_at);
  `,
  `
  -- Before per-owner approvals, a hold lived only in safety.status. Preserve
  -- that room-wide decision explicitly so an upgraded hub never treats the
  -- missing gate/approvals fields as permission to reveal held text.
  UPDATE messages
     SET safety = json_set(
       safety,
       '$.gate',
       CASE json_extract(safety, '$.status')
         WHEN 'held' THEN 'pending'
         WHEN 'rejected' THEN 'rejected'
       END
     )
   WHERE json_valid(safety)
     AND json_extract(safety, '$.status') IN ('held', 'rejected')
     AND json_type(safety, '$.gate') IS NULL
     AND json_type(safety, '$.approvals') IS NULL;

  -- Repair agents created by older admin flows with a foreign org label.
  UPDATE members
     SET org = (SELECT owner.org FROM members AS owner WHERE owner.handle = members.owner_handle)
   WHERE kind = 'agent'
     AND owner_handle IS NOT NULL
     AND EXISTS (SELECT 1 FROM members AS owner WHERE owner.handle = members.owner_handle);
  `,
  `
  -- Gate decisions used to be a bare string plus one global reviewedBy field,
  -- which lost attribution as soon as somebody made a later per-owner review.
  UPDATE messages
     SET safety = json_set(
       safety,
       '$.gate',
       json_object(
         'decision', json_extract(safety, '$.gate'),
         'by', json_extract(safety, '$.reviewedBy')
       )
     )
   WHERE json_valid(safety)
     AND json_type(safety, '$.gate') = 'text';
  `,
];

export function openDb(path: string): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  }
  return db;
}

/** Demo hubs start fresh on every boot unless WARREN_DB says otherwise. */
export function defaultDbPath(demo: boolean): string {
  if (DB_PATH) return DB_PATH;
  return demo ? ":memory:" : join(DATA_DIR, "warren.db");
}

export const db = openDb(defaultDbPath(DEMO));

export function dbHealthy(): boolean {
  try {
    return (db.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
  } catch {
    return false;
  }
}

let closed = false;
export function closeDb() {
  if (closed) return;
  closed = true;
  db.close();
}

/** Runs `fn` in a transaction (nested calls join the outer one). */
let depth = 0;
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec("BEGIN");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  } finally {
    depth--;
  }
}

export function getMeta(key: string): string | undefined {
  return (db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value;
}

export function setMeta(key: string, value: string) {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
