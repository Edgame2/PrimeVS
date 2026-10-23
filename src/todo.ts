import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

export type TodoStatus = "pending" | "active" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  auto: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TodoData {
  autoMode: boolean;
  items: TodoItem[];
}

export interface TodoDispatch {
  /** Send a task to the agent. */
  send: (text: string) => void;
  /** Current active session id (for label purposes). */
  activeSessionId?: string;
}

/**
 * Project-local todo list stored at <workspace>/.primevs/todo.json.
 */
export class TodoStore {
  private data: TodoData = { autoMode: false, items: [] };
  private filePath: string;

  constructor(private workspace: string) {
    this.filePath = path.join(workspace, ".primevs", "todo.json");
    this.load();
  }

  get items(): TodoItem[] {
    return this.data.items;
  }

  get autoMode(): boolean {
    return this.data.autoMode;
  }

  setAutoMode(value: boolean): void {
    this.data.autoMode = value;
    this.save();
  }

  load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
      if (raw && Array.isArray(raw.items)) {
        this.data = { autoMode: Boolean(raw.autoMode), items: raw.items };
      }
    } catch {
      // first run / unreadable file: start empty
    }
  }

  save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    } catch (err) {
      void vscode.window.showErrorMessage(`Prime VS: could not save todo list: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  add(text: string, auto = false): TodoItem {
    const now = new Date().toISOString();
    const item: TodoItem = { id: randomUUID(), text, status: "pending", auto, createdAt: now, updatedAt: now };
    this.data.items.push(item);
    this.save();
    return item;
  }

  updateText(id: string, text: string): void {
    const item = this.data.items.find((i) => i.id === id);
    if (item) {
      item.text = text;
      item.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  setStatus(id: string, status: TodoStatus): void {
    const item = this.data.items.find((i) => i.id === id);
    if (item) {
      item.status = status;
      item.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  toggleAuto(id: string): void {
    const item = this.data.items.find((i) => i.id === id);
    if (item) {
      item.auto = !item.auto;
      item.updatedAt = new Date().toISOString();
      this.save();
    }
  }

  remove(id: string): void {
    this.data.items = this.data.items.filter((i) => i.id !== id);
    this.save();
  }

  clearDone(): void {
    this.data.items = this.data.items.filter((i) => i.status !== "done");
    this.save();
  }

  /** First pending auto item, or undefined. */
  nextAutoItem(): TodoItem | undefined {
    return this.data.items.find((i) => i.auto && i.status === "pending");
  }
}

export class TodoProvider implements vscode.TreeDataProvider<TodoItem> {
  private _onDidChange = new vscode.EventEmitter<TodoItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChange.event;

  constructor(private store: TodoStore) {}

  refresh(item?: TodoItem): void {
    this._onDidChange.fire(item);
  }

  getTreeItem(item: TodoItem): vscode.TreeItem {
    const tree = new vscode.TreeItem(item.text, vscode.TreeItemCollapsibleState.None);
    tree.id = item.id;
    tree.checkboxState = item.status === "done"
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    const tags: string[] = [item.status];
    if (item.auto) {
      tags.push("auto");
    }
    tree.description = tags.join(" · ");
    tree.tooltip = `${item.text}\nStatus: ${item.status}${item.auto ? "\nAuto: yes" : ""}`;
    tree.contextValue = item.status === "done" ? "todoDone" : "todoOpen";
    tree.iconPath = new vscode.ThemeIcon(
      item.status === "done" ? "check" : item.status === "active" ? "play-circle" : "circle-outline"
    );
    return tree;
  }

  getChildren(): TodoItem[] {
    return this.store.items;
  }
}

/** Sequential auto-runner: dispatches the next auto item when the agent is idle. */
export class TodoAutoRunner {
  private dispatchedId: string | undefined;
  private burstCount = 0;
  private maxBurst = 10;

  constructor(
    private store: TodoStore,
    private dispatch: TodoDispatch
  ) {}

  /** Call whenever the agent finishes a turn (agent_end). */
  onAgentIdle(): void {
    if (!this.store.autoMode) {
      return;
    }
    // finish the previously dispatched item
    if (this.dispatchedId) {
      this.store.setStatus(this.dispatchedId, "done");
      this.dispatchedId = undefined;
    }
    // dispatch next pending auto item (within burst limit)
    const next = this.store.nextAutoItem();
    if (!next || this.burstCount >= this.maxBurst) {
      this.burstCount = 0;
      return;
    }
    this.burstCount++;
    this.store.setStatus(next.id, "active");
    this.dispatchedId = next.id;
    this.dispatch.send(
      `Work on this todo item now. When it is fully done, reply with a short summary.\n\n` +
      `**Todo item:** ${next.text}`
    );
  }

  /** Reset burst accounting when auto mode is toggled off. */
  resetBurst(): void {
    this.burstCount = 0;
    this.dispatchedId = undefined;
  }
}

export function registerTodoCommands(
  context: vscode.ExtensionContext,
  store: TodoStore,
  provider: TodoProvider,
  runner: TodoAutoRunner,
  getActiveAgent: () => { send: (cmd: { type: string; message: string }) => void } | undefined
): vscode.TreeView<TodoItem> {
  const treeView = vscode.window.createTreeView("primevs.todoView", { treeDataProvider: provider, showCollapseAll: false });

  treeView.onDidChangeCheckboxState((e) => {
    for (const [item, state] of e.items) {
      store.setStatus(item.id, state === vscode.TreeItemCheckboxState.Checked ? "done" : "pending");
    }
    provider.refresh();
  });

  const start = (item: TodoItem) => {
    const agent = getActiveAgent();
    if (!agent) {
      void vscode.window.showWarningMessage("Prime VS: no active session to run the todo item.");
      return;
    }
    store.setStatus(item.id, "active");
    provider.refresh(item);
    agent.send({
      type: "prompt",
      message: `Work on this todo item now. When it is fully done, reply with a short summary.\n\n**Todo item:** ${item.text}`,
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("primevs.todoAdd", async () => {
      const text = await vscode.window.showInputBox({ prompt: "Todo item" });
      if (text && text.trim()) {
        store.add(text.trim());
        provider.refresh();
      }
    }),
    vscode.commands.registerCommand("primevs.todoStart", (item: TodoItem) => start(item)),
    vscode.commands.registerCommand("primevs.todoToggleAuto", (item: TodoItem) => {
      store.toggleAuto(item.id);
      provider.refresh(item);
    }),
    vscode.commands.registerCommand("primevs.todoEdit", async (item: TodoItem) => {
      const text = await vscode.window.showInputBox({ prompt: "Edit todo item", value: item.text });
      if (text !== undefined && text.trim()) {
        store.updateText(item.id, text.trim());
        provider.refresh(item);
      }
    }),
    vscode.commands.registerCommand("primevs.todoDelete", (item: TodoItem) => {
      store.remove(item.id);
      provider.refresh();
    }),
    vscode.commands.registerCommand("primevs.todoClearDone", () => {
      store.clearDone();
      provider.refresh();
    }),
    vscode.commands.registerCommand("primevs.todoToggleAutoMode", () => {
      store.setAutoMode(!store.autoMode);
      if (!store.autoMode) {
        runner.resetBurst();
      }
      provider.refresh();
      void vscode.window.showInformationMessage(`Prime VS: auto mode ${store.autoMode ? "on" : "off"}.`);
    })
  );

  return treeView;
}
