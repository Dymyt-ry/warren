// Minimal client for the Codex app-server daemon (JSON-RPC over a WebSocket
// on a Unix socket). The interactive `codex` TUI attaches to the same daemon,
// so a turn started here shows up live in the person's open Codex window,
// exactly as if they had typed it. No dependency: the WebSocket framing for
// a local socket is a few lines.
import { createHash, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RpcMessage {
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message?: string };
}

export function codexSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.CODEX_HOME || join(homedir(), ".codex"), "app-server-control", "app-server-control.sock");
}

function encodeFrame(payload: Buffer, opcode = 0x1): Buffer {
  const mask = randomBytes(4);
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, 0x80 | payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

/** Decodes as many complete frames as `buffer` holds; returns them and the rest. */
export function decodeFrames(buffer: Buffer): { frames: { opcode: number; fin: boolean; payload: Buffer }[]; rest: Buffer } {
  const frames: { opcode: number; fin: boolean; payload: Buffer }[] = [];
  let offset = 0;
  for (;;) {
    if (buffer.length - offset < 2) break;
    const first = buffer[offset];
    const second = buffer[offset + 1];
    let length = second & 0x7f;
    let start = offset + 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      start = offset + 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      start = offset + 10;
    }
    const masked = (second & 0x80) !== 0;
    const maskStart = start;
    if (masked) start += 4;
    if (buffer.length < start + length) break;
    let payload = buffer.subarray(start, start + length);
    if (masked) {
      const mask = buffer.subarray(maskStart, maskStart + 4);
      payload = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    }
    frames.push({ opcode: first & 0x0f, fin: (first & 0x80) !== 0, payload });
    offset = start + length;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class CodexAppServer {
  private socket!: Socket;
  private buffer: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closedListeners = new Set<(error?: Error) => void>();
  closed = false;

  static async open(socketPath = codexSocketPath(), clientName = "warren"): Promise<CodexAppServer> {
    const client = new CodexAppServer();
    await client.connect(socketPath);
    await client.call("initialize", { clientInfo: { name: clientName, title: "Warren", version: "1" }, capabilities: null });
    client.notify("initialized");
    return client;
  }

  /** Connects, starting the shared daemon first when it isn't running. */
  static async openOrStart(codexCommand = "codex", socketPath = codexSocketPath()): Promise<CodexAppServer> {
    try {
      return await CodexAppServer.open(socketPath);
    } catch {
      execFileSync(codexCommand, ["app-server", "daemon", "start"], { stdio: "ignore", timeout: 30_000 });
      return await CodexAppServer.open(socketPath);
    }
  }

  private connect(socketPath: string): Promise<void> {
    let path = socketPath;
    try {
      path = realpathSync(socketPath);
    } catch {}
    return new Promise((resolve, reject) => {
      const key = randomBytes(16).toString("base64");
      const expected = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
      let upgraded = false;
      this.socket = connect(path);
      const timer = setTimeout(() => {
        if (upgraded) return;
        reject(new Error("Codex app-server did not answer within 10 s"));
        this.socket.destroy();
      }, 10_000);
      this.socket.once("error", (error) => {
        if (!upgraded) reject(error);
      });
      this.socket.once("close", () => {
        clearTimeout(timer);
        if (!upgraded) reject(new Error("Codex app-server closed the connection before it was ready"));
      });
      this.socket.on("connect", () => {
        this.socket.write(
          `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
            `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        );
      });
      this.socket.on("data", (chunk: Buffer) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!upgraded) {
          const end = this.buffer.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = this.buffer.subarray(0, end).toString();
          this.buffer = this.buffer.subarray(end + 4);
          if (!/^HTTP\/1\.1 101/.test(head) || !head.toLowerCase().includes(expected.toLowerCase())) {
            reject(new Error(`Codex app-server refused the connection (${head.split("\r\n")[0]})`));
            this.socket.destroy();
            return;
          }
          upgraded = true;
          resolve();
        }
        this.drain();
      });
      this.socket.on("close", () => this.finish(new Error("Codex app-server connection closed")));
      this.socket.on("error", (error) => this.finish(error));
    });
  }

  private drain() {
    const { frames, rest } = decodeFrames(this.buffer);
    this.buffer = rest;
    for (const frame of frames) {
      if (frame.opcode === 0x8) return void this.socket.end();
      if (frame.opcode === 0x9) {
        this.socket.write(encodeFrame(frame.payload, 0xa));
        continue;
      }
      if (frame.opcode !== 0x1 && frame.opcode !== 0x0) continue;
      this.fragments.push(frame.payload);
      if (!frame.fin) continue;
      const text = Buffer.concat(this.fragments).toString("utf8");
      this.fragments = [];
      let message: RpcMessage;
      try {
        message = JSON.parse(text) as RpcMessage;
      } catch {
        continue;
      }
      if (message.id !== undefined && !message.method && typeof message.id === "number" && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "Codex app-server error"));
        else waiter.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    }
  }

  private finish(error?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.pending.values()) waiter.reject(error ?? new Error("closed"));
    this.pending.clear();
    for (const listener of this.closedListeners) listener(error);
  }

  private send(message: Record<string, unknown>) {
    if (this.closed) throw new Error("Codex app-server connection is closed");
    this.socket.write(encodeFrame(Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }))));
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`Codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        // An unresponsive daemon: drop the connection so the owner reconnects.
        this.socket.destroy();
      }, timeoutMs);
      const settle = <V>(fn: (value: V) => void) => (value: V) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: settle(resolve as (value: unknown) => void), reject: settle(reject) });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error as Error);
      }
    });
  }

  notify(method: string, params?: Record<string, unknown>) {
    this.send({ method, ...(params ? { params } : {}) });
  }

  onMessage(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onClose(listener: (error?: Error) => void) {
    this.closedListeners.add(listener);
  }

  close() {
    if (this.closed) return;
    try {
      this.socket.write(encodeFrame(Buffer.alloc(0), 0x8));
    } catch {}
    this.socket.end();
    this.finish();
  }
}
