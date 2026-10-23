import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentProcess } from "./agent";

export type SessionSaveMode = "full" | "summarized" | "none";

function textOfContent(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((p: any) => p && p.type === "text")
    .map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "session";
}

function renderMarkdown(messages: any[]): string {
  const lines: string[] = [];
  for (const m of messages) {
    const role = String(m?.role ?? "");
    const text = textOfContent(m);
    if (!text) {
      continue;
    }
    const label = role === "user" ? "## User" : role === "assistant" ? "## Assistant" : `## ${role}`;
    lines.push(label, "", text, "");
  }
  return lines.join("\n");
}

export interface SaveResult {
  path: string;
  mode: SessionSaveMode;
  summary?: string;
}

/**
 * Persist a session transcript into the project: <workspace>/.primevs/sessions/.
 * - full: complete transcript.
 * - summarized: compaction summary + recent messages.
 * - none: no-op.
 */
export async function saveSession(
  agent: AgentProcess,
  name: string,
  id: string,
  mode: SessionSaveMode,
  workspace: string
): Promise<SaveResult | undefined> {
  if (mode === "none") {
    return undefined;
  }

  let summary: string | undefined;
  if (mode === "summarized") {
    const compact = await agent.request({ type: "compact", customInstructions: "Summarize this session for archival." }, 180_000);
    summary = compact.success ? String(compact.data?.summary ?? "") : undefined;
  }

  const res = await agent.request({ type: "get_messages" });
  const messages: any[] = res.success && Array.isArray(res.data?.messages) ? res.data.messages : [];

  const dir = path.join(workspace, ".primevs", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${slug(name)}-${id.slice(0, 6)}.md`);

  const parts: string[] = [`# ${name}`, "", `- Mode: ${mode}`, `- Saved: ${new Date().toISOString()}`, ""];
  if (mode === "summarized" && summary) {
    parts.push("## Summary", "", summary, "", "## Recent messages", "");
  }
  parts.push(renderMarkdown(messages));
  fs.writeFileSync(file, parts.join("\n"), "utf8");

  return { path: file, mode, summary };
}
