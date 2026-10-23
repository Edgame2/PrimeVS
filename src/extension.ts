import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentEvent } from "./types";
import { SessionManager } from "./sessions";
import { ManageViewProvider } from "./manageView";
import { ChangesProvider, changesFromToolEvent, registerChangeCommands } from "./changesTree";
import { TodoStore, TodoProvider, TodoAutoRunner, registerTodoCommands } from "./todo";
import { saveSession, type SessionSaveMode } from "./sessionSaver";

type ImageContent = { type: "image"; data: string; mimeType: string };

type ChatEvent =
  | { type: "user"; text: string }
  | { type: "assistantStart" }
  | { type: "assistantText"; text: string }
  | { type: "assistantEnd" }
  | { type: "toolStart"; id: string; name: string; args: string }
  | { type: "toolUpdate"; id: string; text: string }
  | { type: "toolEnd"; id: string; name: string; isError: boolean }
  | { type: "streaming"; value: boolean }
  | { type: "error"; message: string };

type ToWebview =
  | { type: "meta"; cwd: string }
  | { type: "sessions"; sessions: Array<{ id: string; name: string; streaming: boolean; model: string; saveMode: string }> }
  | { type: "sessionEvent"; sessionId: string; event: ChatEvent }
  | { type: "history"; sessionId: string; messages: Array<{ role: string; text: string }> }
  | { type: "attachResult"; text: string }
  | { type: "dropResult"; text: string; images?: ImageContent[] }
  | { type: "commands"; commands: Array<{ name: string; description: string }> };

type FromWebview =
  | { type: "ready" }
  | { type: "switchSession"; id: string }
  | { type: "newSession" }
  | { type: "closeSession"; id: string }
  | { type: "renameSession"; id: string; name: string }
  | { type: "send"; text: string; images?: ImageContent[] }
  | { type: "steer"; text: string; images?: ImageContent[] }
  | { type: "followUp"; text: string; images?: ImageContent[] }
  | { type: "stop" }
  | { type: "attach" }
  | { type: "renameRequest"; id: string }
  | { type: "dropUris"; uris: string[] };

let sessions: SessionManager | undefined;
let manageProvider: ManageViewProvider | undefined;
let statusBar: vscode.StatusBarItem | undefined;
let outputChannel: vscode.OutputChannel;
let changesProvider: ChangesProvider | undefined;
let todoStore: TodoStore | undefined;
let saveTimers = new Map<string, NodeJS.Timeout>();
let todoRunner: TodoAutoRunner | undefined;

function post(webview: vscode.Webview, msg: ToWebview): void {
  void webview.postMessage(msg);
}

function mimeForExt(ext: string): string {
    switch (ext) {
      case ".png": return "image/png";
      case ".jpg":
      case ".jpeg": return "image/jpeg";
      case ".gif": return "image/gif";
      case ".webp": return "image/webp";
      case ".bmp": return "image/bmp";
      case ".svg": return "image/svg+xml";
      default: return "application/octet-stream";
    }
  }

function textOfContentParts(message: any): string {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((p: any) => p && p.type === "text")
    .map((p: any) => (typeof p.text === "string" ? p.text : ""))
    .join("");
}

function stringifyPartial(partial: any): string {
  if (partial == null) {
    return "";
  }
  const content = Array.isArray(partial?.content)
    ? partial.content
        .filter((p: any) => p && p.type === "text")
        .map((p: any) => p.text ?? "")
        .join("")
    : "";
  if (content) {
    return content;
  }
  if (typeof partial === "string") {
    return partial;
  }
  return JSON.stringify(partial);
}

async function updateStatusBar(): Promise<void> {
  if (!statusBar) {
    return;
  }
  const active = sessions?.active();
  if (!active) {
    statusBar.text = "$(comment-discussion) Prime VS";
    return;
  }
  try {
    const res = await active.agent.request({ type: "get_state" });
    if (res.success) {
      const d = res.data ?? {};
      const model = d.model ? `${d.model.provider}/${d.model.id}` : "no model";
      const changes = changesProvider ? changesProvider.count : 0;
      statusBar.text = `$(comment-discussion) ${active.name} · ${model}`;
      statusBar.tooltip =
        `Session: ${active.name}\nModel: ${model}\nSave mode: ${active.saveMode}\nThinking: ${String(d.thinkingLevel ?? "?")}\n` +
        `Messages: ${String(d.messageCount ?? "?")}\nFiles changed: ${changes}`;
    }
  } catch {
    // transient
  }
}

class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "primevs.chatView";
  private view: vscode.WebviewView | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: FromWebview) => {
      void this.handleWebviewMessage(message);
    });
    if (sessions) {
      this.pushSessions();
      this.pushMeta();
      void this.refreshCommands();
    }
  }

  public pushSessions(): void {
    if (this.view && sessions) {
      post(this.view.webview, {
        type: "sessions",
        sessions: sessions.list().map((s) => ({
          id: s.id,
          name: s.name,
          streaming: s.streaming,
          model: s.model ?? "",
          saveMode: s.saveMode,
        })),
      });
    }
  }

  public refreshModel(id: string): void {
    void sessions?.refreshModel(id).then(() => this.pushSessions());
  }

  public async refreshCommands(): Promise<void> {
    if (!this.view || !sessions?.activeAgent()) {
      return;
    }
    try {
      const res = await sessions.activeAgent()!.request({ type: "get_commands" });
      if (res.success && Array.isArray(res.data?.commands)) {
        const commands = res.data.commands.map((c: any) => ({
          name: String(c?.name ?? ""),
          description: String(c?.description ?? ""),
        }));
        post(this.view.webview, { type: "commands", commands });
      }
    } catch {
      // commands are best-effort
    }
  }

  private saveActiveSession(mode?: SessionSaveMode): void {
    const entry = sessions?.active();
    if (!entry) {
      return;
    }
    const m = mode ?? entry.saveMode;
    void saveSession(entry.agent, entry.name, entry.id, m, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd())
      .then((r) => {
        if (r) {
          outputChannel.appendLine(`saved session to ${r.path}`);
        }
      })
      .catch((err) => outputChannel.appendLine(`session save failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  private pushMeta(): void {
    if (this.view) {
      post(this.view.webview, {
        type: "meta",
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      });
    }
  }

  private async sendHistory(sessionId: string): Promise<void> {
    const entry = sessions?.get(sessionId);
    if (!entry || !this.view) {
      return;
    }
    try {
      const res = await entry.agent.request({ type: "get_messages" });
      if (res.success && Array.isArray(res.data?.messages)) {
        const messages = res.data.messages
          .filter((m: any) => m && (m.role === "user" || m.role === "assistant"))
          .map((m: any) => ({ role: String(m.role), text: textOfContentParts(m) }))
          .filter((m: { text: string }) => m.text.length > 0);
        post(this.view.webview, { type: "history", sessionId, messages });
      }
    } catch {
      // history is best-effort
    }
  }

  private async handleWebviewMessage(message: FromWebview): Promise<void> {
    if (!sessions) {
      return;
    }
    switch (message.type) {
      case "ready":
        this.pushSessions();
        void this.refreshCommands();
        void updateStatusBar();
        break;
      case "switchSession":
        sessions.setActive(message.id);
        this.pushSessions();
        void this.sendHistory(message.id);
        void this.refreshCommands();
        void updateStatusBar();
        break;
      case "newSession": {
        const info = sessions.create();
        this.pushSessions();
        this.refreshModel(info.id);
        void this.refreshCommands();
        void updateStatusBar();
        break;
      }
      case "closeSession": {
        const entry = sessions.get(message.id);
        if (entry && entry.saveMode !== "none") {
          void saveSession(entry.agent, entry.name, entry.id, entry.saveMode, vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd());
        }
        sessions.close(message.id);
        this.pushSessions();
        void updateStatusBar();
        break;
      }
      case "renameSession":
        sessions.rename(message.id, message.name);
        this.pushSessions();
        break;
      case "send":
        sessions.activeAgent()?.send({
          type: "prompt",
          message: message.text,
          ...(message.images?.length ? { images: message.images } : {}),
        });
        break;
      case "steer":
        sessions.activeAgent()?.send({
          type: "steer",
          message: message.text,
          ...(message.images?.length ? { images: message.images } : {}),
        });
        break;
      case "followUp":
        sessions.activeAgent()?.send({
          type: "follow_up",
          message: message.text,
          ...(message.images?.length ? { images: message.images } : {}),
        });
        break;
      case "stop":
        sessions.activeAgent()?.send({ type: "abort" });
        break;
      case "renameRequest": {
        const name = await vscode.window.showInputBox({ prompt: "Session name", value: sessions.get(message.id)?.name });
        if (name) {
          sessions.rename(message.id, name);
          this.pushSessions();
        }
        break;
      }
      case "dropUris": {
        const result = await this.readDroppedUris(message.uris);
        if (this.view && (result.text || result.images.length)) {
          post(this.view.webview, { type: "dropResult", text: result.text, images: result.images });
        }
        break;
      }
      case "attach": {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
          return;
        }
        const sel = editor.selection;
        const text = sel.isEmpty ? editor.document.getText() : editor.document.getText(sel);
        const label = vscode.workspace.asRelativePath(editor.document.uri);
        if (this.view) {
          post(this.view.webview, { type: "attachResult", text: `\`\`\`${label}\n${text}\n\`\`\`` });
        }
        break;
      }
    }
  }

  sessionEvent(sessionId: string, event: AgentEvent): void {
    if (!this.view) {
      return;
    }
    const chat = agentEventToChat(event);
    if (chat) {
      post(this.view.webview, { type: "sessionEvent", sessionId, event: chat });
    }
  }

  private async readDroppedUris(uris: string[]): Promise<{ text: string; images: ImageContent[] }> {
    const parts: string[] = [];
    const images: ImageContent[] = [];
    const imageExts = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);
    for (const u of uris) {
      try {
        if (u.startsWith("file://")) {
          const p = vscode.Uri.parse(u).fsPath;
          const ext = path.extname(p).toLowerCase();
          const stat = fs.statSync(p);
          if (stat.isDirectory()) {
            parts.push(p);
            continue;
          }
          if (imageExts.has(ext)) {
            const data = fs.readFileSync(p).toString("base64");
            images.push({ type: "image", data, mimeType: mimeForExt(ext), ...({ name: path.basename(p) } as any) });
          } else if (stat.size <= 1_000_000) {
            parts.push("```" + path.basename(p) + "\n" + fs.readFileSync(p, "utf8") + "\n```");
          } else {
            parts.push(p);
          }
        } else if (u.startsWith("vscode-file://")) {
          const bytes = await vscode.workspace.fs.readFile(vscode.Uri.parse(u));
          parts.push("```file\n" + Buffer.from(bytes).toString("utf8") + "\n```");
        } else if (u.startsWith("/")) {
          parts.push("```" + path.basename(u) + "\n" + fs.readFileSync(u, "utf8") + "\n```");
        } else {
          parts.push(u);
        }
      } catch {
        parts.push(u);
      }
    }
    return { text: parts.join("\n\n"), images };
  }

  public async pickModel(): Promise<void> {
    const active = sessions?.activeAgent();
    if (!active) {
      return;
    }
    try {
      const res = await active.request({ type: "get_available_models" });
      const models: Array<{ provider: string; id: string; label: string }> = (
        (res.success && Array.isArray(res.data?.models) ? res.data.models : [])
      ).map((m: any) => {
        const provider = String(m?.provider ?? "");
        const id = String(m?.id ?? "");
        return { provider, id, label: `${provider}/${id}` };
      });
      if (models.length === 0) {
        void vscode.window.showInformationMessage("Prime VS: no models reported by the agent.");
        return;
      }
      const picked = await vscode.window.showQuickPick(models.map((m) => m.label), { placeHolder: "Select model" });
      if (!picked) {
        return;
      }
      const model = models.find((m) => m.label === picked)!;
      const set = await active.request({ type: "set_model", provider: model.provider, modelId: model.id });
      void (set.success
        ? vscode.window.showInformationMessage(`Prime VS: model set to ${picked}`)
        : vscode.window.showErrorMessage(`Prime VS: ${set.error ?? "could not set model"}`));
      if (set.success && sessions?.activeId) {
        this.refreshModel(sessions.activeId);
      }
      void updateStatusBar();
    } catch (err) {
      void vscode.window.showErrorMessage(`Prime VS: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"));
    const nonce = "primevs-nonce";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Prime VS</title>
</head>
<body>
  <div id="tabs"></div>
  <div id="chat"></div>
  <div id="cmds" class="hidden"></div>
  <div id="composer">
    <div id="chips"></div>
    <textarea id="input" placeholder="Message Prime-Agent… (Enter to send · drag & drop files · paste images)"></textarea>
    <div id="actions">
      <button id="attachBtn" title="Attach active file / selection">Attach</button>
      <button id="stopBtn" title="Stop the current turn" disabled>Stop</button>
      <button id="steerBtn" title="Queue a steering message during the turn" disabled>Steer</button>
      <button id="followBtn" title="Queue a follow-up after the turn" disabled>Follow-up</button>
      <button id="sendBtn">Send</button>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function agentEventToChat(event: AgentEvent): ChatEvent | null {
  switch (event.type) {
    case "message_start": {
      const role = event.message?.role;
      if (role === "user") {
        return { type: "user", text: textOfContentParts(event.message) };
      }
      if (role === "assistant") {
        return { type: "assistantText", text: textOfContentParts(event.message) };
      }
      return null;
    }
    case "message_update": {
      const kind = event.assistantMessageEvent?.type;
      if (kind === "text_start" || kind === "text_delta" || kind === "text_end") {
        return { type: "assistantText", text: textOfContentParts(event.message) };
      }
      return null;
    }
    case "message_end":
      if (event.message?.role === "assistant") {
        return { type: "assistantEnd" };
      }
      return null;
    case "tool_execution_start":
      return {
        type: "toolStart",
        id: String(event.toolCallId ?? "tool"),
        name: String(event.toolName ?? "tool"),
        args: JSON.stringify(event.args ?? {}),
      };
    case "tool_execution_update":
      return { type: "toolUpdate", id: String(event.toolCallId ?? "tool"), text: stringifyPartial(event.partialResult) };
    case "tool_execution_end":
      if (changesProvider) {
        changesProvider.add(changesFromToolEvent(event));
      }
      return {
        type: "toolEnd",
        id: String(event.toolCallId ?? "tool"),
        name: String(event.toolName ?? "tool"),
        isError: Boolean(event.isError),
      };
    case "turn_start":
    case "agent_start":
      return { type: "streaming", value: true };
    case "agent_end":
      return { type: "streaming", value: false };
    default:
      return null;
  }
}

async function handleExtensionUiRequest(sessionId: string, event: AgentEvent): Promise<void> {
  const agent = sessions?.get(sessionId)?.agent;
  if (!agent) {
    return;
  }
  const id = String(event.id ?? "");
  const method = String(event.method ?? "");
  const reply = (payload: Record<string, unknown>) =>
    agent.send({ type: "extension_ui_response", id, ...payload });

  switch (method) {
    case "select": {
      const options = Array.isArray(event.options) ? event.options.map(String) : [];
      const picked = await vscode.window.showQuickPick(options, { title: String(event.title ?? "Select") });
      reply(picked === undefined ? { cancelled: true } : { value: picked });
      break;
    }
    case "confirm": {
      const choice = await vscode.window.showWarningMessage(
        String(event.title ?? "Confirm"),
        { modal: true, detail: String(event.message ?? "") },
        "Yes",
        "No"
      );
      reply(choice === "Yes" ? { confirmed: true } : choice === "No" ? { confirmed: false } : { cancelled: true });
      break;
    }
    case "input": {
      const value = await vscode.window.showInputBox({
        title: String(event.title ?? "Input"),
        placeHolder: String(event.placeholder ?? ""),
      });
      reply(value === undefined ? { cancelled: true } : { value });
      break;
    }
    case "editor": {
      const doc = await vscode.workspace.openTextDocument({ content: String(event.prefill ?? ""), language: "plaintext" });
      await vscode.window.showTextDocument(doc);
      reply({ value: doc.getText() });
      break;
    }
    case "notify":
      void vscode.window.showInformationMessage(String(event.message ?? ""));
      break;
    default:
      break;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel("Prime VS");
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const agentPathSetting = (): string => vscode.workspace.getConfiguration("primevs").get("agentPath", "");

  const provider = new ChatViewProvider(context);
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider));

  const defaultSaveMode = (vscode.workspace.getConfiguration("primevs").get("sessionSaveMode", "full") as SessionSaveMode) || "full";
  sessions = new SessionManager({
    cwd: workspace,
    agentPath: agentPathSetting(),
    defaultSaveMode,
    onSessionEvent: (sessionId, event) => {
      if (event.type === "extension_ui_request") {
        void handleExtensionUiRequest(sessionId, event);
        return;
      }
      provider.sessionEvent(sessionId, event);
      if (event.type === "agent_end") {
        void updateStatusBar();
        todoRunner?.onAgentIdle();
        const entry = sessions?.get(sessionId);
        if (entry && entry.saveMode === "full") {
          const existing = saveTimers.get(sessionId);
          if (existing) {
            clearTimeout(existing);
          }
          saveTimers.set(
            sessionId,
            setTimeout(() => {
              saveTimers.delete(sessionId);
              void saveSession(entry.agent, entry.name, entry.id, "full", workspace);
            }, 2000)
          );
        }
      }
    },
    onSessionsChanged: () => {
      // ChatViewProvider pushes the tab list itself when it has a view; this
      // callback also refreshes the status bar.
      void updateStatusBar();
    },
    onStderr: (sessionId, line) => outputChannel.appendLine(`[${sessionId}] ${line}`),
  });

  // start with one default session
  sessions.create();
  if (sessions.activeId) {
    provider.refreshModel(sessions.activeId);
  }

  manageProvider = new ManageViewProvider(
    context,
    () => sessions?.activeAgent(),
    () => {
      const id = sessions?.activeId;
      if (id) {
        sessions?.restart(id);
      }
    },
    () => {
      const id = sessions?.activeId;
      if (id) {
        provider.refreshModel(id);
      }
    }
  );
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(ManageViewProvider.viewType, manageProvider));

  changesProvider = new ChangesProvider();
  context.subscriptions.push(vscode.window.registerTreeDataProvider("primevs.changesView", changesProvider));
  registerChangeCommands(context, changesProvider);

  todoStore = new TodoStore(workspace);
  const todoProvider = new TodoProvider(todoStore);
  todoRunner = new TodoAutoRunner(todoStore, {
    send: (text) => sessions?.activeAgent()?.send({ type: "prompt", message: text }),
  });
  registerTodoCommands(context, todoStore, todoProvider, todoRunner, () => sessions?.activeAgent());

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = "primevs.chatView.focus";
  statusBar.text = "$(comment-discussion) Prime VS";
  statusBar.tooltip = "Prime VS: Prime-Agent chat";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("primevs.newSession", () => {
      sessions?.create();
    }),
    vscode.commands.registerCommand("primevs.stop", () => sessions?.activeAgent()?.send({ type: "abort" })),
    vscode.commands.registerCommand("primevs.pickModel", () => provider.pickModel()),
    vscode.commands.registerCommand("primevs.manage", async () => {
      await vscode.commands.executeCommand("primevs.manageView.focus");
    }),
    vscode.commands.registerCommand("primevs.showTranscript", async () => {
      const active = sessions?.activeAgent();
      if (!active) {
        return;
      }
      const res = await active.request({ type: "export_html" }, 120_000);
      if (res.success && typeof res.data?.path === "string") {
        await vscode.env.openExternal(vscode.Uri.file(res.data.path));
      } else {
        void vscode.window.showErrorMessage(`Prime VS: ${res.error ?? "export failed"}`);
      }
    }),
    vscode.commands.registerCommand("primevs.compact", async () => {
      const res = sessions?.activeAgent()
        ? await sessions.activeAgent()!.request({ type: "compact" }, 120_000)
        : undefined;
      void vscode.window.showInformationMessage(res?.success ? "Prime VS: context compacted." : `Prime VS: ${res?.error ?? "no active session"}`);
    }),
    vscode.commands.registerCommand("primevs.fork", async () => {
      const active = sessions?.activeAgent();
      if (!active) {
        return;
      }
      const messages = await active.request({ type: "get_fork_messages" });
      const entries: Array<{ id: string; label: string }> = (
        (messages.success && Array.isArray(messages.data?.messages) ? messages.data.messages : []) as any[]
      ).map((m: any, i: number) => ({ id: String(m.id ?? i), label: String(m.text ?? m.role ?? "").slice(0, 60) }));
      const picked = await vscode.window.showQuickPick(entries.map((e) => e.label), { placeHolder: "Fork from message…" });
      if (!picked) {
        return;
      }
      const entry = entries.find((e) => e.label === picked)!;
      const res = await active.request({ type: "fork", entryId: entry.id });
      void vscode.window.showInformationMessage(res.success ? "Prime VS: forked session." : `Prime VS: ${res.error}`);
    }),
    vscode.commands.registerCommand("primevs.clone", async () => {
      const res = sessions?.activeAgent() ? await sessions.activeAgent()!.request({ type: "clone" }) : undefined;
      void vscode.window.showInformationMessage(res?.success ? "Prime VS: session cloned." : `Prime VS: ${res?.error ?? "no active session"}`);
    }),
    vscode.commands.registerCommand("primevs.setSessionSaveMode", async () => {
      const id = sessions?.activeId;
      if (!id) {
        return;
      }
      const current = sessions?.get(id)?.saveMode ?? "full";
      const picked = await vscode.window.showQuickPick(["full", "summarized", "none"], {
        placeHolder: "Session save mode",
      });
      if (picked) {
        sessions?.setSaveMode(id, picked as SessionSaveMode);
        provider.pushSessions?.();
        void updateStatusBar();
        void vscode.window.showInformationMessage(`Prime VS: session save mode set to ${picked}.`);
      }
    }),
    vscode.commands.registerCommand("primevs.saveSessionNow", () => {
      const entry = sessions?.active();
      if (!entry) {
        return;
      }
      void saveSession(entry.agent, entry.name, entry.id, entry.saveMode, workspace).then((r) => {
        void vscode.window.showInformationMessage(r ? `Prime VS: saved session to ${r.path}` : "Prime VS: save mode is 'none'.");
      });
    }),
    vscode.commands.registerCommand("primevs.stats", async () => {
      const res = sessions?.activeAgent() ? await sessions.activeAgent()!.request({ type: "get_session_stats" }) : undefined;
      if (res?.success) {
        void vscode.window.showInformationMessage(JSON.stringify(res.data, null, 2), { modal: true });
      }
    })
  );

  void updateStatusBar();
}

export function deactivate(): void {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  for (const s of sessions?.list() ?? []) {
    const entry = sessions?.get(s.id);
    if (entry && entry.saveMode !== "none") {
      void saveSession(entry.agent, entry.name, entry.id, entry.saveMode, workspace);
    }
  }
  sessions?.dispose();
  sessions = undefined;
  statusBar?.dispose();
  outputChannel?.dispose();
}
