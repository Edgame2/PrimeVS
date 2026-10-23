import * as vscode from "vscode";
import { execFile } from "node:child_process";
import type { AgentProcess } from "./agent";
import {
  readAuth,
  writeAuth,
  readSettings,
  writeSettings,
  type ManagementSnapshot,
  type McpServerConfig,
  type PrimeSettings,
} from "./configStore";

type ManageRequest =
  | { action: "refresh" }
  | { action: "setModel"; provider: string; id: string }
  | { action: "saveProvider"; name: string; key: string; baseUrl?: string }
  | { action: "deleteProvider"; name: string }
  | { action: "setDefault"; provider?: string; model?: string }
  | { action: "saveMcp"; name: string; config: McpServerConfig }
  | { action: "deleteMcp"; name: string }
  | { action: "newSession" }
  | { action: "renameSession"; name: string }
  | { action: "goalSet"; objective: string; tokenBudget?: number }
  | { action: "goalPause" }
  | { action: "goalResume" }
  | { action: "goalClear" }
  | { action: "goalStatus" }
  | { action: "addSchedule"; schedule: string; prompt: string }
  | { action: "cancelSchedule"; jobId: string }
  | { action: "setHeartbeat"; schedule: string; prompt: string; deliveryMode?: string };

type ManageResponse =
  | { type: "snapshot"; data: ManagementSnapshot }
  | { type: "status"; text: string; kind: "info" | "error" }
  | { type: "goalUpdate"; goal: NonNullable<ManagementSnapshot["goal"]> | null };

function execJson(command: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 15_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export class ManageViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "primevs.manageView";
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getAgent: () => AgentProcess | undefined,
    private readonly restartAgent: () => void,
    private readonly onModelChanged: () => void = () => undefined
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((message: ManageRequest) => {
      void this.handleRequest(message);
    });
  }

  private post(msg: ManageResponse): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    }
  }

  private status(text: string, kind: "info" | "error" = "info"): void {
    this.post({ type: "status", text, kind });
  }

  goalUpdate(goal: ManagementSnapshot["goal"]): void {
    this.post({ type: "goalUpdate", goal });
  }

  async snapshot(): Promise<ManagementSnapshot> {
    const auth = readAuth();
    const settings = readSettings();
    const providers = Object.entries(auth).map(([name, entry]) => ({
      name,
      hasKey: Boolean(entry?.key),
      type: String(entry?.type ?? "api_key"),
    }));
    const mcp = Object.entries(settings.mcpServers ?? {}).map(([name, config]) => ({ name, config }));

    const agent = this.getAgent();
    let models: ManagementSnapshot["models"] = [];
    let currentModel: ManagementSnapshot["currentModel"] = null;
    let goal: ManagementSnapshot["goal"] = null;
    try {
      const modelsRes = agent ? await agent.request({ type: "get_available_models" }) : undefined;
      if (modelsRes?.success && Array.isArray(modelsRes.data?.models)) {
        models = modelsRes.data.models.map((m: any) => ({
          provider: String(m?.provider ?? ""),
          id: String(m?.id ?? ""),
          name: m?.name ? String(m.name) : undefined,
        }));
      }
      const stateRes = agent ? await agent.request({ type: "get_state" }) : undefined;
      if (stateRes?.success) {
        const data = stateRes.data ?? {};
        if (data.model) {
          currentModel = {
            provider: String(data.model.provider ?? ""),
            id: String(data.model.id ?? ""),
          };
        }
        if (data.goal && (data.goal.active || data.goal.status !== "idle")) {
          goal = {
            active: Boolean(data.goal.active),
            status: String(data.goal.status ?? "idle"),
            goalId: data.goal.goalId ? String(data.goal.goalId) : undefined,
            objective: data.goal.objective ? String(data.goal.objective) : undefined,
            tokenBudget: typeof data.goal.tokenBudget === "number" ? data.goal.tokenBudget : undefined,
            tokensUsed: typeof data.goal.tokensUsed === "number" ? data.goal.tokensUsed : 0,
            timeUsedSeconds: typeof data.goal.timeUsedSeconds === "number" ? data.goal.timeUsedSeconds : 0,
            continuationsUsed: typeof data.goal.continuationsUsed === "number" ? data.goal.continuationsUsed : 0,
            createdAt: typeof data.goal.createdAt === "number" ? data.goal.createdAt : undefined,
            updatedAt: typeof data.goal.updatedAt === "number" ? data.goal.updatedAt : undefined,
            lastReason: data.goal.lastReason ? String(data.goal.lastReason) : undefined,
            lastError: data.goal.lastError ? String(data.goal.lastError) : undefined,
          };
        }
      }
    } catch {
      // agent may be mid-restart; snapshot still returns what we have
    }

    let agents: ManagementSnapshot["agents"] = [];
    try {
      const list = await execJson("prime-agent", ["list", "--json"]);
      agents = (list.sessions ?? []).map((s: any) => ({
        id: String(s.id ?? s.sessionId ?? ""),
        name: s.sessionName || (s.cwd ? String(s.cwd).split("/").pop() : undefined) || String(s.id ?? ""),
        state: s.lifecycle === "live" ? "running" : "saved",
        model: s.model?.id ? String(s.model.id) : undefined,
      }));
    } catch {
      // listing agents is best-effort
    }

    let schedules: any[] = [];
    let heartbeats: any[] = [];
    try {
      const s = agent ? await agent.request({ type: "list_schedules" }) : undefined;
      if (s?.success && Array.isArray(s.data?.jobs)) {
        schedules = s.data.jobs;
      }
      const h = agent ? await agent.request({ type: "list_heartbeats" }) : undefined;
      if (h?.success && Array.isArray(h.data?.heartbeats)) {
        heartbeats = h.data.heartbeats;
      }
    } catch {
      // schedules are best-effort
    }

    return {
      providers,
      settings: {
        defaultProvider: settings.defaultProvider ?? "",
        defaultModel: settings.defaultModel ?? "",
      },
      mcp,
      models,
      currentModel,
      agents,
      goal,
      schedules,
      heartbeats,
    };
  }

  private async handleRequest(req: ManageRequest): Promise<void> {
    try {
      switch (req.action) {
        case "refresh":
          this.post({ type: "snapshot", data: await this.snapshot() });
          return;
        case "setModel": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({ type: "set_model", provider: req.provider, modelId: req.id });
          if (res.success) {
            this.status(`Model set to ${req.provider}/${req.id}`);
            this.onModelChanged();
          } else {
            this.status(res.error ?? "Could not set model", "error");
          }
          break;
        }
        case "saveProvider": {
          const auth = readAuth();
          const existing = auth[req.name] ?? { type: "api_key" };
          auth[req.name] = {
            ...existing,
            type: existing.type || "api_key",
            ...(req.key ? { key: req.key } : {}),
            ...(req.baseUrl ? { baseUrl: req.baseUrl } : {}),
          };
          writeAuth(auth);
          this.status(`Provider "${req.name}" saved. Restarting agent…`);
          this.restartAgent();
          break;
        }
        case "deleteProvider": {
          const auth = readAuth();
          delete auth[req.name];
          writeAuth(auth);
          this.status(`Provider "${req.name}" removed. Restarting agent…`);
          this.restartAgent();
          break;
        }
        case "setDefault": {
          const settings = readSettings();
          if (req.provider !== undefined) {
            settings.defaultProvider = req.provider;
          }
          if (req.model !== undefined) {
            settings.defaultModel = req.model;
          }
          writeSettings(settings);
          this.status("Default provider/model saved. Restarting agent…");
          this.restartAgent();
          break;
        }
        case "saveMcp": {
          const settings = readSettings();
          settings.mcpServers = settings.mcpServers ?? {};
          settings.mcpServers[req.name] = req.config;
          writeSettings(settings);
          this.status(`MCP server "${req.name}" saved. Restarting agent…`);
          this.restartAgent();
          break;
        }
        case "deleteMcp": {
          const settings = readSettings();
          if (settings.mcpServers) {
            delete settings.mcpServers[req.name];
            writeSettings(settings);
            this.status(`MCP server "${req.name}" removed. Restarting agent…`);
            this.restartAgent();
          }
          break;
        }
        case "newSession": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({ type: "new_session" });
          if (res.success) {
            this.status("New session started.");
          } else {
            this.status(res.error ?? "Could not start a new session", "error");
          }
          break;
        }
        case "renameSession": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({ type: "set_session_name", name: req.name });
          if (res.success) {
            this.status(`Session renamed to "${req.name}".`);
          } else {
            this.status(res.error ?? "Could not rename session", "error");
          }
          break;
        }
        case "addSchedule": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({ type: "add_schedule", schedule: req.schedule, prompt: req.prompt });
          if (res.success) {
            this.status("Schedule added.");
          } else {
            this.status(res.error ?? "Could not add schedule", "error");
          }
          break;
        }
        case "cancelSchedule": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({ type: "cancel_schedule", jobId: req.jobId });
          if (res.success) {
            this.status("Schedule cancelled.");
          } else {
            this.status(res.error ?? "Could not cancel schedule", "error");
          }
          break;
        }
        case "setHeartbeat": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const res = await agent.request({
            type: "set_heartbeat",
            schedule: req.schedule,
            prompt: req.prompt,
            ...(req.deliveryMode ? { deliveryMode: req.deliveryMode } : {}),
          });
          if (res.success) {
            this.status("Heartbeat set.");
          } else {
            this.status(res.error ?? "Could not set heartbeat", "error");
          }
          break;
        }
        case "goalSet": {
          const agent = this.getAgent();
          if (!agent) {
            this.status("Agent is not running", "error");
            return;
          }
          const objective = req.objective.trim();
          if (!objective) {
            this.status("Objective is empty", "error");
            return;
          }
          const budget = req.tokenBudget && req.tokenBudget > 0 ? `--budget ${req.tokenBudget} ` : "";
          agent.send({ type: "prompt", message: `/goal ${budget}${objective}` });
          this.status("Goal set — the agent will pursue it.");
          break;
        }
        case "goalPause": {
          this.getAgent()?.send({ type: "prompt", message: "/goal pause" });
          this.status("Goal pause requested.");
          break;
        }
        case "goalResume": {
          this.getAgent()?.send({ type: "prompt", message: "/goal resume" });
          this.status("Goal resume requested.");
          break;
        }
        case "goalClear": {
          this.getAgent()?.send({ type: "prompt", message: "/goal clear" });
          this.status("Goal clear requested.");
          break;
        }
        case "goalStatus": {
          this.getAgent()?.send({ type: "prompt", message: "/goal status" });
          break;
        }
      }
      this.post({ type: "snapshot", data: await this.snapshot() });
    } catch (err) {
      this.status(err instanceof Error ? err.message : String(err), "error");
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "manage.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "media", "manage.css"));
    const nonce = "primevs-manage-nonce";
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Prime VS Manage</title>
</head>
<body>
  <div id="tabs">
    <button data-tab="model" class="active">Model</button>
    <button data-tab="providers">Providers</button>
    <button data-tab="mcp">MCP</button>
    <button data-tab="agents">Agents</button>
    <button data-tab="goals">Goals</button>
  </div>
  <div id="status"></div>
  <div id="panes"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
