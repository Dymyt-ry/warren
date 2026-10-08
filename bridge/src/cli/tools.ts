import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { hubOrigin, readFolder } from "./config.js";

interface Credentials {
  hub: string;
  token: string;
}

interface CredentialOverrides {
  hub?: string;
  token?: string;
}

function credentials(dir: string, overrides: CredentialOverrides): Credentials {
  const suppliedHub = overrides.hub ?? process.env.WARREN_HUB;
  const suppliedToken = overrides.token ?? process.env.WARREN_TOKEN;
  // Fully headless calls must not inspect a project-controlled credential file.
  const folder = suppliedHub && suppliedToken ? undefined : readFolder(dir);
  const hub = suppliedHub ?? folder?.hub;
  const token = suppliedToken ?? folder?.token;
  if (!hub || !token)
    throw new Error("no Warren agent configured; run `warren add ...` here or set WARREN_HUB and WARREN_TOKEN");
  return { hub: hubOrigin(hub), token };
}

async function connected<T>(dir: string, version: string, overrides: CredentialOverrides, fn: (client: Client) => Promise<T>): Promise<T> {
  const { hub, token } = credentials(dir, overrides);
  const client = new Client({ name: "warren-cli", version });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${hub}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }),
    );
    return await fn(client);
  } catch (error) {
    throw new Error(`cannot use the Warren hub at ${hub} (${(error as Error).message})`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function textContent(content: unknown): string | undefined {
  if (!Array.isArray(content) || content.length !== 1) return undefined;
  const item = content[0] as { type?: unknown; text?: unknown };
  return item.type === "text" && typeof item.text === "string" ? item.text : undefined;
}

/** Print a tool result without wrapping its JSON text in another JSON string. */
function printResult(result: unknown) {
  const value = result as { content?: unknown; isError?: boolean; structuredContent?: unknown };
  const text = textContent(value.content);
  if (value.isError) throw new Error(text ?? "Warren tool failed");
  if (text !== undefined) return void console.log(text);
  console.log(JSON.stringify(value.structuredContent ?? value.content ?? null, null, 2));
}

export async function callHubTool(
  dir: string,
  version: string,
  name: string,
  args: Record<string, unknown>,
  overrides: CredentialOverrides = {},
) {
  if (!name) throw new Error("tool name is required");
  const result = await connected(dir, version, overrides, (client) => client.callTool({ name, arguments: args }));
  printResult(result);
}

export async function listHubTools(dir: string, version: string, overrides: CredentialOverrides = {}) {
  const result = await connected(dir, version, overrides, (client) => client.listTools());
  console.log(
    JSON.stringify(
      result.tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      null,
      2,
    ),
  );
}

export function objectInput(value: string | undefined): Record<string, unknown> {
  if (!value) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`--input must be valid JSON (${(error as Error).message})`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") throw new Error("--input must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function positiveLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) throw new Error("--limit must be an integer from 1 to 100");
  return Number(value);
}
