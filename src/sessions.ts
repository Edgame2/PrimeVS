import { AgentProcess } from "./agent";
import type { AgentEvent } from "./types";

export type SessionSaveMode = "full" | "summarized" | "none";

export interface SessionInfo {
  id: string;
  name: string;
  streaming: boolean;
  model?: string;
  saveMode: SessionSaveMode;
}

export interface SessionManagerOptions {
  cwd: string;
  agentPath: string;
  defaultSaveMode: SessionSaveMode;
  onSessionEvent: (sessionId: string, event: AgentEvent) => void;
  onSessionsChanged: () => void;
  onStderr: (sessionId: string, line: string) => void;
}

interface SessionEntry {
  id: string;
  name: string;
  agent: AgentProcess;
  streaming: boolean;
  model?: string;
  saveMode: SessionSaveMode;
}

/**
 * Owns multiple concurrent `prime-agent --mode rpc` processes (one session per
 * process, per the protocol's one-session-per-connection limit).
 */
export class SessionManager {
  private sessions = new Map<string, SessionEntry>();
  private seq = 0;
  private _activeId: string | undefined;

  constructor(private opts: SessionManagerOptions) {}

  get activeId(): string | undefined {
    return this._activeId;
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      name: s.name,
      streaming: s.streaming,
      model: s.model,
      saveMode: s.saveMode,
    }));
  }

  get(id: string): SessionEntry | undefined {
    return this.sessions.get(id);
  }

  active(): SessionEntry | undefined {
    return this._activeId ? this.sessions.get(this._activeId) : undefined;
  }

  activeAgent(): AgentProcess | undefined {
    return this.active()?.agent;
  }

  setActive(id: string): void {
    if (this.sessions.has(id)) {
      this._activeId = id;
    }
  }

  create(name?: string): SessionInfo {
    const id = `s${++this.seq}-${Date.now().toString(36)}`;
    const sessionName = name || `Session ${this.seq}`;
    const entry: SessionEntry = {
      id,
      name: sessionName,
      agent: undefined as unknown as AgentProcess,
      streaming: false,
      saveMode: this.opts.defaultSaveMode,
    };

    const spawn = (): AgentProcess => {
      const p = new AgentProcess({
        cwd: this.opts.cwd,
        agentPath: this.opts.agentPath,
        onEvent: (event) => {
          const cur = this.sessions.get(id);
          if (cur) {
            if (event.type === "turn_start" || event.type === "agent_start") {
              cur.streaming = true;
            } else if (event.type === "agent_end") {
              cur.streaming = false;
            }
            this.opts.onSessionEvent(id, event);
          }
        },
        onExit: (code, signal) => {
          const cur = this.sessions.get(id);
          if (cur) {
            cur.streaming = false;
          }
          this.opts.onStderr(id, `prime-agent exited (code=${code}, signal=${signal})`);
          this.opts.onSessionsChanged();
        },
        onStderr: (line) => this.opts.onStderr(id, line),
      });
      p.start();
      return p;
    };

    entry.agent = spawn();
    this.sessions.set(id, entry);
    this._activeId = id;
    this.opts.onSessionsChanged();
    return this.info(entry);
  }

  close(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) {
      return;
    }
    entry.agent.dispose();
    this.sessions.delete(id);
    if (this._activeId === id) {
      const first = [...this.sessions.values()][0];
      this._activeId = first ? first.id : undefined;
    }
    this.opts.onSessionsChanged();
  }

  rename(id: string, name: string): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.name = name;
      this.opts.onSessionsChanged();
    }
  }

  setSaveMode(id: string, mode: SessionSaveMode): void {
    const entry = this.sessions.get(id);
    if (entry) {
      entry.saveMode = mode;
      this.opts.onSessionsChanged();
    }
  }

  restart(id: string): void {
    const entry = this.sessions.get(id);
    if (!entry) {
      return;
    }
    const old = entry.agent;
    entry.agent = this.spawnFor(id);
    old.dispose();
    this.opts.onSessionsChanged();
  }

  async refreshModel(id: string): Promise<void> {
    const entry = this.sessions.get(id);
    if (!entry) {
      return;
    }
    try {
      const res = await entry.agent.request({ type: "get_state" });
      if (res.success && res.data?.model) {
        entry.model = `${res.data.model.provider}/${res.data.model.id}`;
      }
    } catch {
      // keep previous model on transient errors
    }
    this.opts.onSessionsChanged();
  }

  private spawnFor(id: string): AgentProcess {
    const p = new AgentProcess({
      cwd: this.opts.cwd,
      agentPath: this.opts.agentPath,
      onEvent: (event) => {
        const cur = this.sessions.get(id);
        if (cur) {
          if (event.type === "turn_start" || event.type === "agent_start") {
            cur.streaming = true;
          } else if (event.type === "agent_end") {
            cur.streaming = false;
          }
          this.opts.onSessionEvent(id, event);
        }
      },
      onExit: (code, signal) => {
        const cur = this.sessions.get(id);
        if (cur) {
          cur.streaming = false;
        }
        this.opts.onStderr(id, `prime-agent exited (code=${code}, signal=${signal})`);
        this.opts.onSessionsChanged();
      },
      onStderr: (line) => this.opts.onStderr(id, line),
    });
    p.start();
    return p;
  }

  dispose(): void {
    for (const entry of this.sessions.values()) {
      entry.agent.dispose();
    }
    this.sessions.clear();
    this._activeId = undefined;
  }

  private info(entry: SessionEntry): SessionInfo {
    return { id: entry.id, name: entry.name, streaming: entry.streaming, model: entry.model, saveMode: entry.saveMode };
  }
}
