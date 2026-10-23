import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FileChange {
  id: string;
  path: string;
  oldStr: string;
  newStr: string;
  startLine?: number;
  diffText: string;
  toolName: string;
}

/**
 * Collect file changes from a finished tool call. Prime-Agent applies edits
 * directly; this tree gives visibility + revert for what changed.
 */
export function changesFromToolEvent(event: any): FileChange[] {
  const out: FileChange[] = [];
  const toolName = String(event?.toolName ?? "");
  const args = event?.args ?? {};
  const details = event?.result?.details ?? {};

  // ipython tool: KernelDiffDisplay[] { path, oldStr, newStr, startLine }
  const diffs = details.diffs;
  if (toolName === "ipython" && Array.isArray(diffs)) {
    for (const d of diffs) {
      if (d && typeof d.path === "string" && typeof d.oldStr === "string" && typeof d.newStr === "string") {
        out.push({
          id: `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          path: d.path,
          oldStr: d.oldStr,
          newStr: d.newStr,
          startLine: typeof d.startLine === "number" ? d.startLine : undefined,
          diffText: unifiedDiff(d.path, d.oldStr, d.newStr, d.startLine),
          toolName,
        });
      }
    }
    return out;
  }

  // edit tool: { path } args + details.diff
  if (toolName === "edit" && typeof args.path === "string") {
    const diffText = typeof details.diff === "string" ? details.diff : "";
    out.push({
      id: `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      path: args.path,
      oldStr: "",
      newStr: "",
      startLine: typeof details.firstChangedLine === "number" ? details.firstChangedLine : undefined,
      diffText,
      toolName,
    });
  }

  return out;
}

function unifiedDiff(filePath: string, oldStr: string, newStr: string, startLine?: number): string {
  const a = oldStr.split("\n");
  const b = newStr.split("\n");
  const start = typeof startLine === "number" ? startLine : 1;
  const lines: string[] = [`--- ${filePath}`, `+++ ${filePath}`];
  // simple single-hunk diff of the two snippets
  const max = Math.max(a.length, b.length);
  let lineNo = start;
  for (let i = 0; i < max; i++) {
    const ao = i < a.length ? a[i] : null;
    const bn = i < b.length ? b[i] : null;
    if (ao === bn) {
      lines.push(` ${lineNo}\t${ao ?? ""}`);
      lineNo++;
    } else {
      if (ao !== null) lines.push(`-${lineNo}\t${ao}`);
      if (bn !== null) lines.push(`+${lineNo}\t${bn}`);
      lineNo++;
    }
  }
  return lines.join("\n");
}

export class ChangesProvider implements vscode.TreeDataProvider<FileChange> {
  private _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private changes: FileChange[] = [];

  add(changes: FileChange[]): void {
    if (changes.length) {
      this.changes.push(...changes);
      this._onDidChange.fire();
    }
  }

  clear(): void {
    this.changes = [];
    this._onDidChange.fire();
  }

  remove(change: FileChange): void {
    this.changes = this.changes.filter((c) => c.id !== change.id);
    this._onDidChange.fire();
  }

  get count(): number {
    return this.changes.length;
  }

  getTreeItem(element: FileChange): vscode.TreeItem {
    const item = new vscode.TreeItem(path.basename(element.path), vscode.TreeItemCollapsibleState.None);
    item.description = element.path;
    item.tooltip = element.diffText;
    item.contextValue = "fileChange";
    return item;
  }

  getChildren(): FileChange[] {
    return this.changes;
  }
}

export function registerChangeCommands(
  context: vscode.ExtensionContext,
  provider: ChangesProvider
): void {
  const viewDiff = (change: FileChange) => {
    const doc = vscode.workspace.openTextDocument({
      content: change.diffText,
      language: "diff",
    });
    void doc.then((d) => vscode.window.showTextDocument(d, { preview: true }));
  };

  const revert = async (change: FileChange) => {
    if (!change.oldStr && !change.newStr) {
      void vscode.window.showWarningMessage("Prime VS: no revert data for this change.");
      return;
    }
    try {
      const abs = path.isAbsolute(change.path)
        ? change.path
        : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(), change.path);
      const current = fs.readFileSync(abs, "utf8");
      // swap old/new to revert
      const reverted = current.replace(change.newStr, change.oldStr);
      if (reverted === current) {
        void vscode.window.showWarningMessage(`Prime VS: could not find the changed text in ${change.path} to revert.`);
        return;
      }
      fs.writeFileSync(abs, reverted, "utf8");
      provider.remove(change);
      void vscode.window.showInformationMessage(`Prime VS: reverted ${change.path}`);
    } catch (err) {
      void vscode.window.showErrorMessage(`Prime VS: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("primevs.viewDiff", (change: FileChange) => viewDiff(change)),
    vscode.commands.registerCommand("primevs.revertChange", (change: FileChange) => void revert(change)),
    vscode.commands.registerCommand("primevs.clearChanges", () => provider.clear())
  );
}
