// Prime VS management webview
(function () {
  const vscode = acquireVsCodeApi();
  const tabsEl = document.getElementById("tabs");
  const statusEl = document.getElementById("status");
  const panesEl = document.getElementById("panes");

  let snapshot = null;
  let activeTab = "model";

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = kind === "error" ? "error" : "";
    if (text) {
      setTimeout(() => { if (statusEl.textContent === text) statusEl.textContent = ""; }, 6000);
    }
  }

  function post(message) {
    vscode.postMessage(message);
  }

  function field(labelText, input) {
    const row = el("div", "row");
    const label = el("label", "label", labelText);
    row.appendChild(label);
    row.appendChild(input);
    return row;
  }

  function input(value, placeholder, type) {
    const i = el("input");
    i.type = type || "text";
    i.value = value || "";
    if (placeholder) i.placeholder = placeholder;
    return i;
  }

  function button(label, onClick, primary) {
    const b = el("button", primary ? "primary" : "", label);
    b.addEventListener("click", onClick);
    return b;
  }

  function render() {
    panesEl.innerHTML = "";
    if (!snapshot) {
      panesEl.appendChild(el("div", "empty", "No data yet…"));
      return;
    }
    const pane = el("div", "pane");
    if (activeTab === "model") renderModel(pane);
    else if (activeTab === "providers") renderProviders(pane);
    else if (activeTab === "mcp") renderMcp(pane);
    else if (activeTab === "agents") renderAgents(pane);
    else if (activeTab === "goals") renderGoals(pane);
    else if (activeTab === "schedules") renderSchedules(pane);
    panesEl.appendChild(pane);
  }

  function section(title) {
    const s = el("div", "section");
    s.appendChild(el("h3", "section-title", title));
    return s;
  }

  function renderModel(pane) {
    const current = snapshot.currentModel;
    const cur = section("Current model");
    cur.appendChild(el("div", "muted", current ? `${current.provider}/${current.id}` : "unknown"));
    pane.appendChild(cur);

    const s = section("Available models");
    const list = el("div", "list");
    (snapshot.models || []).forEach((m) => {
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", `${m.provider}/${m.id}`));
      if (m.name) info.appendChild(el("div", "muted", m.name));
      row.appendChild(info);
      const use = button("Use", () => post({ action: "setModel", provider: m.provider, id: m.id }));
      row.appendChild(use);
      list.appendChild(row);
    });
    if (!(snapshot.models || []).length) {
      list.appendChild(el("div", "muted", "No models reported."));
    }
    s.appendChild(list);
    pane.appendChild(s);
  }

  function renderProviders(pane) {
    const s = section("Providers (API keys in ~/.prime/agent/auth.json)");
    const list = el("div", "list");
    (snapshot.providers || []).forEach((p) => {
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", p.name));
      info.appendChild(el("div", "muted", `${p.type}${p.hasKey ? " · key set" : " · no key"}`));
      row.appendChild(info);
      row.appendChild(button("Set default", () => post({ action: "setDefault", provider: p.name })));
      row.appendChild(button("Delete", () => post({ action: "deleteProvider", name: p.name }), false));
      list.appendChild(row);
    });
    s.appendChild(list);
    pane.appendChild(s);

    const add = section("Add / edit provider");
    const nameInput = input("", "provider name (e.g. anthropic, openrouter, deepseek)");
    const keyInput = input("", "API key", "password");
    const urlInput = input("", "base URL (optional)");
    add.appendChild(field("Name", nameInput));
    add.appendChild(field("API key", keyInput));
    add.appendChild(field("Base URL", urlInput));
    add.appendChild(button("Save provider", () => {
      if (!nameInput.value.trim()) { setStatus("Provider name is required", "error"); return; }
      post({
        action: "saveProvider",
        name: nameInput.value.trim(),
        key: keyInput.value.trim(),
        baseUrl: urlInput.value.trim() || undefined,
      });
    }, true));
    pane.appendChild(add);

    const def = section("Default provider / model");
    const dp = input(snapshot.settings.defaultProvider, "default provider");
    const dm = input(snapshot.settings.defaultModel, "default model");
    def.appendChild(field("Provider", dp));
    def.appendChild(field("Model", dm));
    def.appendChild(button("Save defaults", () => post({
      action: "setDefault",
      provider: dp.value.trim() || undefined,
      model: dm.value.trim() || undefined,
    }), true));
    pane.appendChild(def);
  }

  function renderMcp(pane) {
    const s = section("MCP servers (settings.json)");
    const list = el("div", "list");
    (snapshot.mcp || []).forEach((entry) => {
      const c = entry.config || {};
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", entry.name));
      info.appendChild(el("div", "muted", c.type === "http" ? `http · ${c.url}` : `stdio · ${c.command} ${(c.args || []).join(" ")}`));
      row.appendChild(info);
      row.appendChild(button("Delete", () => post({ action: "deleteMcp", name: entry.name })));
      list.appendChild(row);
    });
    if (!(snapshot.mcp || []).length) {
      list.appendChild(el("div", "muted", "No MCP servers configured."));
    }
    s.appendChild(list);
    pane.appendChild(s);

    const add = section("Add / edit MCP server");
    const nameInput = input("", "name");
    const typeSel = el("select");
    ["stdio", "http"].forEach((t) => {
      const opt = el("option", "", t);
      opt.value = t;
      typeSel.appendChild(opt);
    });
    const urlInput = input("", "http URL");
    const cmdInput = input("", "command (for stdio)");
    const argsInput = input("", "args, comma separated");
    add.appendChild(field("Name", nameInput));
    add.appendChild(field("Type", typeSel));
    add.appendChild(field("URL (http)", urlInput));
    add.appendChild(field("Command (stdio)", cmdInput));
    add.appendChild(field("Args (stdio)", argsInput));
    add.appendChild(button("Save MCP server", () => {
      const name = nameInput.value.trim();
      if (!name) { setStatus("Name is required", "error"); return; }
      const config = typeSel.value === "http"
        ? { type: "http", url: urlInput.value.trim() || undefined, enabled: true }
        : {
            type: "stdio",
            command: cmdInput.value.trim() || undefined,
            args: argsInput.value.trim() ? argsInput.value.split(",").map((a) => a.trim()).filter(Boolean) : undefined,
            enabled: true,
          };
      post({ action: "saveMcp", name, config });
    }, true));
    pane.appendChild(add);
  }

  function renderAgents(pane) {
    const s = section("Agents / sessions");
    const list = el("div", "list");
    (snapshot.agents || []).forEach((a) => {
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", a.name));
      info.appendChild(el("div", "muted", `${a.state} · ${a.model || "no model"} · ${a.id}`));
      row.appendChild(info);
      list.appendChild(row);
    });
    if (!(snapshot.agents || []).length) {
      list.appendChild(el("div", "muted", "No agents."));
    }
    s.appendChild(list);
    pane.appendChild(s);

    const create = section("Create agent");
    create.appendChild(el("div", "muted", "Starts a fresh session in the current Prime-Agent process."));
    create.appendChild(button("New session", () => post({ action: "newSession" }), true));
    const renameInput = input("", "session name");
    create.appendChild(field("Session name", renameInput));
    create.appendChild(button("Rename session", () => {
      if (renameInput.value.trim()) post({ action: "renameSession", name: renameInput.value.trim() });
    }));
    pane.appendChild(create);
  }

  function renderGoals(pane) {
    const g = snapshot.goal;
    const s = section("Thread goal");
    if (g) {
      s.appendChild(el("div", "", `Status: ${g.status}`));
      if (g.objective) s.appendChild(el("div", "", `Objective: ${g.objective}`));
      if (g.goalId) s.appendChild(el("div", "muted", `ID: ${g.goalId}`));
      if (g.tokenBudget) s.appendChild(el("div", "muted", `Budget: ${g.tokenBudget} tokens`));
      s.appendChild(el("div", "muted", `Tokens used: ${g.tokensUsed} · Time: ${(g.timeUsedSeconds / 60).toFixed(1)} min · Continuations: ${g.continuationsUsed}`));
      if (g.lastReason) s.appendChild(el("div", "muted", `Reason: ${g.lastReason}`));
      if (g.lastError) s.appendChild(el("div", "error", `Error: ${g.lastError}`));
    } else {
      s.appendChild(el("div", "muted", "No active goal."));
    }
    pane.appendChild(s);

    const controls = section("Controls");
    const row = el("div", "row");
    row.appendChild(button("Refresh", () => post({ action: "goalStatus" })));
    if (g && (g.status === "active" || g.status === "budget_limited")) {
      row.appendChild(button("Pause", () => post({ action: "goalPause" })));
    }
    if (g && (g.status === "paused" || g.status === "budget_limited")) {
      row.appendChild(button("Resume", () => post({ action: "goalResume" })));
    }
    if (g) {
      row.appendChild(button("Clear", () => post({ action: "goalClear" })));
    }
    controls.appendChild(row);
    pane.appendChild(controls);

    const create = section("Set goal");
    const objInput = el("textarea");
    objInput.placeholder = "Objective for the persistent goal";
    const budgetInput = input("", "token budget (optional)");
    create.appendChild(field("Objective", objInput));
    create.appendChild(field("Token budget", budgetInput));
    create.appendChild(button("Set goal", () => {
      if (!objInput.value.trim()) { setStatus("Objective is required", "error"); return; }
      post({
        action: "goalSet",
        objective: objInput.value.trim(),
        tokenBudget: budgetInput.value.trim() ? parseInt(budgetInput.value.trim(), 10) : undefined,
      });
    }, true));
    pane.appendChild(create);
  }

  function renderSchedules(pane) {
    const s = section("Schedules");
    const list = el("div", "list");
    (snapshot.schedules || []).forEach((j) => {
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", j.schedule + " · " + j.status));
      info.appendChild(el("div", "muted", (j.prompt || "").slice(0, 80)));
      row.appendChild(info);
      row.appendChild(button("Cancel", () => post({ action: "cancelSchedule", jobId: j.id })));
      list.appendChild(row);
    });
    if (!(snapshot.schedules || []).length) list.appendChild(el("div", "muted", "No schedules."));
    s.appendChild(list);
    pane.appendChild(s);

    const add = section("Add schedule");
    const schedInput = input("", "cron expression or interval (e.g. */10 * * * * or 10m)");
    const promptInput = input("", "prompt");
    add.appendChild(field("Schedule", schedInput));
    add.appendChild(field("Prompt", promptInput));
    add.appendChild(button("Add schedule", () => {
      if (!schedInput.value.trim() || !promptInput.value.trim()) { setStatus("Schedule and prompt are required", "error"); return; }
      post({ action: "addSchedule", schedule: schedInput.value.trim(), prompt: promptInput.value.trim() });
    }, true));
    pane.appendChild(add);

    const hb = section("Heartbeats");
    const hbList = el("div", "list");
    (snapshot.heartbeats || []).forEach((h) => {
      const row = el("div", "list-row");
      const info = el("div", "grow");
      info.appendChild(el("div", "", h.schedule + " · " + h.status));
      info.appendChild(el("div", "muted", (h.prompt || "").slice(0, 80)));
      row.appendChild(info);
      hbList.appendChild(row);
    });
    if (!(snapshot.heartbeats || []).length) hbList.appendChild(el("div", "muted", "No heartbeats."));
    hb.appendChild(hbList);
    pane.appendChild(hb);

    const hbAdd = section("Set heartbeat");
    const hbSched = input("", "schedule (e.g. 15m)");
    const hbPrompt = input("", "prompt");
    hbAdd.appendChild(field("Schedule", hbSched));
    hbAdd.appendChild(field("Prompt", hbPrompt));
    hbAdd.appendChild(button("Set heartbeat", () => {
      if (!hbSched.value.trim() || !hbPrompt.value.trim()) { setStatus("Schedule and prompt are required", "error"); return; }
      post({ action: "setHeartbeat", schedule: hbSched.value.trim(), prompt: hbPrompt.value.trim(), deliveryMode: "steer" });
    }, true));
    pane.appendChild(hbAdd);
  }

  // --- tabs ---
  tabsEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-tab]");
    if (!btn) return;
    activeTab = btn.dataset.tab;
    tabsEl.querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    render();
  });

  // --- messages from extension ---
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg.type !== "string") return;
    if (msg.type === "snapshot") {
      snapshot = msg.data;
      render();
    } else if (msg.type === "status") {
      setStatus(msg.text, msg.kind);
    } else if (msg.type === "goalUpdate") {
      snapshot = snapshot || {};
      snapshot.goal = msg.goal;
      if (activeTab === "goals") render();
    }
  });

  post({ action: "refresh" });
})();
