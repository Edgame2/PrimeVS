import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RpcCommand, RpcResponse, AgentEvent } from "./types";

let nextId = 0;

function resolveAgentPath(configured: string | undefined): string {
  if (configured && configured.trim().length > 0) {
    return configured;
  }
  const candidates = [
    join(homedir(), ".npm-global", "bin", "prime-agent"),
    join(homedir(), ".local", "bin", "prime-agent"),
    "/usr/local/bin/prime-agent",
    "/usr/bin/prime-agent",
  ];
  for (const c of candidates) {
    if (isProbablyExecutable(c)) {
      return c;
    }
  }
  return "prime-agent"; // rely on PATH as a last resort
}

function isProbablyExecutable(_p: string): boolean {
  // A cheap existence check without fs is enough here; spawn will report a real
  // error if the resolved path is wrong and PATH fallback can be used by clearing
  // the setting.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    require("node:fs").accessSync(_p, require("node:fs").constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export interface AgentProcessOptions {
  cwd: string;
  agentPath?: string;
  extraArgs?: string[];
  model?: string;
  provider?: string;
  onEvent: (event: AgentEvent) => void;
  onExit: (code: number | null, signal: string | null) => void;
  onStderr: (line: string) => void;
}

/**
 * Owns a single `prime-agent --mode rpc` child process and speaks the JSONL
 * protocol: one JSON object per line on stdin/stdout, split strictly on `\n`.
 */
export class AgentProcess {
  private child: ChildProcessWithoutNullStreams | undefined;
  private buffer = "";
  private pending = new Map<string, (res: RpcResponse) => void>();
  private emitter = new EventEmitter();
  private _streaming = false;

  constructor(private options: AgentProcessOptions) {}

  get streaming(): boolean {
    return this._streaming;
  }

  start(): void {
    const args = ["--mode", "rpc", "--cwd", this.options.cwd];
    if (this.options.provider) {
      args.push("--provider", this.options.provider);
    }
    if (this.options.model) {
      args.push("--model", this.options.model);
    }
    if (this.options.extraArgs) {
      args.push(...this.options.extraArgs);
    }

    const path = resolveAgentPath(this.options.agentPath);
    this.child = spawn(path, args, {
      cwd: this.options.cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    this.child.stdout.on("data", (chunk: string) => this.ingest(chunk));
    this.child.stderr.on("data", (chunk: string) => {
      for (const line of chunk.split("\n")) {
        if (line.trim().length > 0) {
          this.options.onStderr(line);
        }
      }
    });
    this.child.on("error", (err) => {
      this.options.onStderr(`failed to start agent: ${err.message}`);
      this.options.onExit(null, null);
    });
    this.child.on("exit", (code, signal) => {
      this.child = undefined;
      this.options.onExit(code, signal);
    });
  }

  private ingest(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, "");
      this.buffer = this.buffer.slice(idx + 1);
      if (line.trim().length === 0) {
        continue;
      }
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      this.options.onStderr(`unparseable JSON from agent: ${line.slice(0, 200)}`);
      return;
    }

    if (obj && obj.type === "response") {
      const res = obj as RpcResponse;
      if (res.id && this.pending.has(res.id)) {
        const resolve = this.pending.get(res.id)!;
        this.pending.delete(res.id);
        resolve(res);
      }
      return;
    }

    if (obj && typeof obj.type === "string") {
      this.trackStreaming(obj);
      this.options.onEvent(obj as AgentEvent);
    }
  }

  private trackStreaming(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
      case "agent_start":
        this._streaming = true;
        break;
      case "agent_end":
        this._streaming = false;
        break;
    }
  }

  /** Fire-and-forget command. */
  send(command: RpcCommand): void {
    if (!this.child || this.child.killed) {
      this.options.onStderr("agent is not running");
      return;
    }
    this.child.stdin.write(JSON.stringify(command) + "\n");
  }

  /** Send a command and wait for its response (with timeout). */
  request(command: RpcCommand, timeoutMs = 60_000): Promise<RpcResponse> {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error("agent is not running"));
        return;
      }
      const id = command.id ?? `req-${++nextId}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${command.type} response`));
      }, timeoutMs);
      this.pending.set(id, (res) => {
        clearTimeout(timer);
        resolve(res);
      });
      this.child.stdin.write(JSON.stringify({ ...command, id }) + "\n");
    });
  }

  on(event: "exit", listener: (code: number | null, signal: string | null) => void): void;
  on(event: "event", listener: (event: AgentEvent) => void): void;
  on(event: string, listener: (...args: any[]) => void): void {
    this.emitter.on(event, listener);
  }

  dispose(): void {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.pending.clear();
  }
}
