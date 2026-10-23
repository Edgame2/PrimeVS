import * as fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const AGENT_DIR = process.env.PRIME_AGENT_DIR || join(homedir(), ".prime", "agent");
const AUTH_PATH = join(AGENT_DIR, "auth.json");
const SETTINGS_PATH = join(AGENT_DIR, "settings.json");

export interface ProviderAuth {
  type: string;
  key?: string;
  baseUrl?: string;
  [key: string]: unknown;
}

export interface McpServerConfig {
  type: "http" | "stdio";
  url?: string;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  oauth?: boolean;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  enabled?: boolean;
  enabledTools?: string[];
  disabledTools?: string[];
}

export interface PrimeSettings {
  defaultProvider?: string;
  defaultModel?: string;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

function readJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(path: string, value: unknown): void {
  fs.writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

export function readAuth(): Record<string, ProviderAuth> {
  return readJson<Record<string, ProviderAuth>>(AUTH_PATH, {});
}

export function writeAuth(auth: Record<string, ProviderAuth>): void {
  writeJson(AUTH_PATH, auth);
}

export function readSettings(): PrimeSettings {
  return readJson<PrimeSettings>(SETTINGS_PATH, {});
}

export function writeSettings(settings: PrimeSettings): void {
  writeJson(SETTINGS_PATH, settings);
}

/** Shape of the full management snapshot sent to the webview. */
export interface ManagementSnapshot {
  providers: Array<{ name: string; hasKey: boolean; type: string }>;
  settings: { defaultProvider: string; defaultModel: string };
  mcp: Array<{ name: string; config: McpServerConfig }>;
  models: Array<{ provider: string; id: string; name?: string }>;
  currentModel: { provider: string; id: string } | null;
  agents: Array<{ id: string; name: string; state: string; model?: string }>;
  goal: {
    active: boolean;
    status: string;
    objective: string;
    tokenBudget?: number;
    tokensUsed: number;
  } | null;
  schedules: Array<{
    id: string;
    status: string;
    schedule: string;
    prompt: string;
    nextRunAt?: string;
  }>;
  heartbeats: Array<{
    id: string;
    status: string;
    schedule: string;
    prompt: string;
  }>;
}
