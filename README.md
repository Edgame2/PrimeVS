# Prime VS

A VS Code extension that drives **Prime-Agent** from a sidebar — a Cursor-like chat
with streaming, markdown, images, file-change visibility, and full management of
models, providers, MCP servers, agents, goals and schedules.

## Views

- **Chat** — streaming markdown replies, live tool output, images (paste), attach
  active file/selection, Steer and Follow-up controls.
- **Manage** — tabs for Model, Providers, MCP, Agents, Goals and Schedules.
- **Changes** — files the agent edited, with View Diff and Revert.

## Features

- **Chat**: markdown + code blocks, history replay on reload, image paste,
  attach active file/selection, steer/follow-up while streaming, Stop.
- **Model**: list models, switch the active model.
- **Providers**: add / edit / remove API keys (`~/.prime/agent/auth.json`),
  set default provider/model (`settings.json`).
- **MCP**: add / edit / remove MCP servers (HTTP or stdio).
- **Agents**: list agents (`prime-agent list --json`), new session, rename.
- **Goals**: view the active thread goal, create a goal with an optional budget.
- **Schedules**: list / add / cancel schedules and heartbeats.
- **Changes**: diff view + revert of the agent's file edits.
- **Native dialogs**: select/confirm/input/editor extension UI requests surface as
  VS Code pickers/inputs.
- **Session controls**: compact, fork, clone, session stats, transcript export.
- **Session saving**: per-session + global save mode — Full / Summarized / No Save —
  stored in `.primevs/sessions/` inside the project.
- **Todo list**: project-local `.primevs/todo.json` with start, auto mode, and
  editable items.
- **Status bar**: current model + save mode + file-change count.

Configuration changes (providers, MCP, defaults) restart the agent to take effect.

## Setup

1. Install `prime-agent` (set `primevs.agentPath` if not auto-detected).
2. Build:

   ```bash
   npm install
   npm run compile
   ```

3. F5 (Run Extension) or install the VSIX: **Extensions → Install from VSIX…**.

## Commands

| Command | Description |
| --- | --- |
| `Prime VS: New Session` | Fresh session |
| `Prime VS: Stop` | Abort running turn |
| `Prime VS: Pick Model` | Switch model |
| `Prime VS: Compact Context` | Compaction |
| `Prime VS: Fork Session` / `Clone Session` | Session branching |
| `Prime VS: Session Stats` | Token/usage stats |
| `Prime VS: Show Session Transcript (HTML)` | Export transcript |
| `Prime VS: Open Management Panel` | Focus Manage view |
| `Prime VS: Set Session Save Mode` | Full / Summarized / No Save for the active session |
| `Prime VS: Save Session Now` | Save the active session transcript immediately |

## Keybindings

- `Ctrl+Alt+N` — new session (in chat view)
- `Ctrl+Alt+S` — stop (in chat view)

## Roadmap

- Pre-execution permission gate (approve edits before they run).
- Parallel background agents via the daemon socket.
- Subagent tree visualization.
- Autonomous mode and continual-harness refine controls.
